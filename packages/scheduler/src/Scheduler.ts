import { getCurrentTime } from '../../shared/utils'
import { peek, pop, push } from './SchedulerMinHeap'
import { PriorityLevel, getTimeoutByPriorityLevel } from './SchedulerPriorities'

let taskIdCounter = 0
// 检查主线程有没有调度
let isHostCallbackScheduled = false
// 检查当前是否有延迟任务在做倒计时
let isHostTimeoutScheduled = false
// 检查work是否在执行
let isPerformingWork = false
// 检查当前通道有没有打开
let isMessageLoopRunning = false

// 主线程调度的函数
let scheduledHostCallback
let taskTimeoutId = -1 // 定时器id
let startTime // 时间切片的起始时间
let frameInterval = 5 // 时间切片间隔时间

interface Task {
  id: number
  priorityLevel: PriorityLevel
  callback: () => void
  startTime: number // 任务开始时间，标记任务进入任务池的时间
  expirationTime: number // 过期时间，任务理论执行时间
  sortIndex: number // 索引 用于优先级排序
}

// 立即要执行的任务池
const taskQueue: Task[] = []
// 有延迟的任务池
const timerQueue: Task[] = []

export function scheduleCallback(
  priorityLevel: PriorityLevel,
  callback: any,
  options?: { delay?: number }
) {
  const currentTime = getCurrentTime()
  const startTime = currentTime + (options?.delay || 0)
  const expirationTime = startTime + getTimeoutByPriorityLevel(priorityLevel)
  const task: Task = {
    id: taskIdCounter++,
    priorityLevel,
    callback,
    startTime,
    expirationTime,
    sortIndex: 0
  }

  // 两种任务 有delay 无delay
  // 任务有延迟
  if (startTime > currentTime) {
    // 执行时间越早，从延迟任务池捞出来越早
    task.sortIndex = startTime
    push(timerQueue, task)

    // 当前立即执行的任务池为空，并且当前task是延迟任务的堆顶任务
    if (peek(taskQueue) === null && task === peek(timerQueue)) {
      // 当前有其他延迟任务正在倒计时
      if (isHostTimeoutScheduled === true) {
        // 取消正在倒计时的任务
        cancelHostTimeout()
      } else {
        isHostTimeoutScheduled = true
      }
      requestHostTimeout(handleTimeout, startTime - currentTime)
    }
  }
  // 无延迟任务
  else {
    // 任务过期时间越早，从立即执行任务池捞出来越早
    task.sortIndex = expirationTime
    push(taskQueue, task)

    if (!isHostCallbackScheduled && !isPerformingWork) {
      isHostCallbackScheduled = true
      requestHostCallback(flushWork)
    }
  }

  // 检查主线程是否被占用
  // 设置一个锁
}

function requestHostTimeout(handleTimeout: any, timeout: number) {
  if (isHostTimeoutScheduled === false) {
    isHostTimeoutScheduled = true
    taskTimeoutId = setTimeout(() => {
      handleTimeout(getCurrentTime())
    }, timeout) as any
  }
}
function cancelHostTimeout() {
  clearTimeout(taskTimeoutId)
  taskTimeoutId = -1
}

function handleTimeout(currentTime: number) {
  isHostTimeoutScheduled = false
  advanceTimers(currentTime)
  if (!isHostCallbackScheduled) {
    if (peek(taskQueue) !== null) {
      isHostCallbackScheduled = true
      requestHostCallback(flushWork)
    } else {
      const top = peek(timerQueue) as Task
      if (top) {
        requestHostTimeout(handleTimeout, top.startTime - currentTime)
      }
    }
  }
}

// 检查timerQueue里面的任务有没有到达执行时间
// 有就把任务从tiemrQueue里面放到taskQueue里
function advanceTimers(currentTime: number) {
  let top = peek(timerQueue) as Task
  while (top) {
    if (top.callback === null) {
      pop(timerQueue)
    } else if (top.startTime <= currentTime) {
      pop(timerQueue)
      top.sortIndex = top.expirationTime
      push(taskQueue, top)
    } else {
      break
    }
    top = peek(timerQueue) as Task
  }
}

// 取消任务
export function cancelCallback(task: Task) {
  task.callback = null
}

let schedulePerformWorkUntilDeadline
// 时间切片内执行（work是指一个或多个task）
function performWorkUntilDealine() {
  if (scheduledHostCallback) {
    const currentTime = getCurrentTime()
    startTime = currentTime
    const hasTimeRemaining = true
    let hasMoreWork = true
    try {
      hasMoreWork = scheduledHostCallback(hasTimeRemaining, currentTime)
    } finally {
      if (hasMoreWork) {
        schedulePerformWorkUntilDeadline()
      } else {
        isMessageLoopRunning = false
        scheduledHostCallback = null
      }
    }
  } else {
    isMessageLoopRunning = false
  }
}

// 消息通道
const channel = new MessageChannel()
channel.port1.onmessage = performWorkUntilDealine
schedulePerformWorkUntilDeadline = () => {
  channel.port2.postMessage(0)
}

function requestHostCallback(callback) {
  scheduledHostCallback = callback
}

// 执行work（work是指一个或多个task）
function flushWork(hasTimeRemaining: boolean, initialTime: number) {
  isHostCallbackScheduled = false
  if (isHostTimeoutScheduled) {
    isHostTimeoutScheduled = false
    cancelHostTimeout()
  }
  isPerformingWork = true

  try {
    return workLoop(hasTimeRemaining, initialTime)
  } finally {
    isPerformingWork = false
  }
}

// 循环task
function workLoop(hasTimeRemaining: boolean, initialTime: number) {
  let currentTime = initialTime
  advanceTimers(currentTime)
  let currentTask = peek(taskQueue) as Task
  while (currentTask) {
    if (currentTask.expirationTime > currentTime && shouldYieldToHost()) {
      break
    }
    const callback = currentTask.callback
    if (callback === null) {
      pop(taskQueue)
    } else {
      currentTask.callback = null
      const continuationCallback = callback()
      currentTime = getCurrentTime()
      if (typeof continuationCallback === 'function') {
        currentTask.callback = continuationCallback
        advanceTimers(currentTime)
        return true
      } else {
        if (currentTask === peek(taskQueue)) {
          pop(taskQueue)
        }
        advanceTimers(currentTime)
      }
    }
    currentTask = peek(taskQueue) as Task
  }

  if (currentTask !== null) {
    return true
  } else {
    const top = peek(taskQueue) as Task
    if (top) {
      requestHostTimeout(flushWork, top.startTime - currentTime)
    }
    return false
  }
}

// 是否应该把控制权交给主线程
function shouldYieldToHost() {
  const timeElapsed = getCurrentTime() - startTime
  return timeElapsed >= frameInterval
}

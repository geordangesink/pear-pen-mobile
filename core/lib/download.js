module.exports = async function download(
  core,
  start,
  end,
  { timeout, onprogress }
) {
  if (start >= end) return
  let range
  let timer
  let rejectTimeout
  const stalled = new Promise((resolve, reject) => {
    rejectTimeout = reject
  })
  const refresh = () => {
    clearTimeout(timer)
    timer = setTimeout(
      () =>
        rejectTimeout(
          new Error(
            'The source data is unavailable. Keep its peer online and try again'
          )
        ),
      timeout
    )
  }
  const progress = (index) => {
    if (index >= start && index < end) {
      refresh()
      onprogress?.()
    }
  }
  core.on('download', progress)
  try {
    refresh()
    range = core.download({ start, end })
    await Promise.race([range.done(), stalled])
  } finally {
    clearTimeout(timer)
    core.off('download', progress)
    range?.destroy()
  }
}

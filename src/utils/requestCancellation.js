/** Tie a generation's lifetime to the HTTP response, not the uploaded body. */
export function requestCancellation(request) {
  const controller = new AbortController();
  const response = request.raw.res;
  const abort = () => controller.abort();
  const onClose = () => {
    if (!response.writableFinished) abort();
  };

  response.once('close', onClose);
  request.events.once('disconnect', abort);
  if (request.raw.req.aborted || response.destroyed) abort();

  return {
    signal: controller.signal,
    dispose() {
      response.removeListener('close', onClose);
      request.events.removeListener('disconnect', abort);
    },
  };
}

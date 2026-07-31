// Worker-facing sogni-api media endpoints. Both are gated only on the job
// being an active project (Redis active-project-worker), so no auth header is
// required — and the DTO validation runs forbidNonWhitelisted, so any extra
// query param is a 400. Send exactly the params below and nothing else.

async function requestJson(url, { fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(url, { method: 'GET', signal });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // fall through to the status check with a null body
  }
  if (!response.ok) {
    const detail = body?.message || body?.error || `HTTP ${response.status}`;
    throw new Error(`sogni-api request failed: ${detail}`);
  }
  return body;
}

// GET /v1/media/uploadUrl?jobId&type=complete&id&contentType -> presigned PUT.
// The handler also records the upload descriptor the broker verifies after
// jobCompleted, so the contentType here must match the PUT's header exactly.
// NOTE: the media path's asset-id param is `id` (the image path uses imageId).
export async function requestMediaUploadUrl({ apiUrl, jobId, imgId, contentType, fetchImpl, signal }) {
  const url = new URL('/v1/media/uploadUrl', apiUrl);
  url.searchParams.set('jobId', jobId);
  url.searchParams.set('type', 'complete');
  url.searchParams.set('id', imgId);
  url.searchParams.set('contentType', contentType);

  const body = await requestJson(url, { fetchImpl, signal });
  const uploadUrl = body?.data?.uploadUrl;
  if (typeof uploadUrl !== 'string' || !uploadUrl) {
    throw new Error('sogni-api returned no uploadUrl');
  }
  return uploadUrl;
}

// GET /v1/media/downloadUrl?jobId&type=referenceAudio -> presigned GET for the
// artist-uploaded input asset. The asset key is derived from (jobId, type), so
// no id param exists for inputs.
export async function requestMediaDownloadUrl({ apiUrl, jobId, type = 'referenceAudio', fetchImpl, signal }) {
  const url = new URL('/v1/media/downloadUrl', apiUrl);
  url.searchParams.set('jobId', jobId);
  url.searchParams.set('type', type);

  const body = await requestJson(url, { fetchImpl, signal });
  const downloadUrl = body?.data?.downloadUrl;
  if (typeof downloadUrl !== 'string' || !downloadUrl) {
    throw new Error('sogni-api returned no downloadUrl');
  }
  return downloadUrl;
}

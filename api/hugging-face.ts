import { Buffer } from 'buffer';

type JsonRecord = Record<string, unknown>;

const jsonResponse = (data: JsonRecord, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const fetchWithRetry = async (url: string, options: RequestInit, attempt = 0): Promise<Response> => {
  const response = await fetch(url, options);
  if (response.status === 503 && attempt === 0) {
    await sleep(1500);
    return fetchWithRetry(url, options, attempt + 1);
  }
  return response;
};

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method Not Allowed' }, 405);
  }

  let payload: JsonRecord;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }
    payload = parsed as JsonRecord;
  } catch (err) {
    console.error('Invalid JSON payload for Hugging Face request', err);
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const rawModelId = typeof payload?.modelId === 'string' ? payload.modelId : '';
  const normalizedModelId = rawModelId.trim().replace(/\u2013|\u2014/g, '-');

  if (!/^[\w.-]+\/[\w.-]+$/i.test(normalizedModelId)) {
    return jsonResponse({ error: 'Invalid model id' }, 400);
  }

  const token = process.env.HUGGING_FACE_TOKEN || process.env.HUGGING_FACE_API_TOKEN || process.env.HF_KEY;
  if (!token) {
    return jsonResponse({ error: 'Missing Hugging Face API token' }, 500);
  }

  const [org, name] = normalizedModelId.split('/');
  const requestUrl = `https://api-inference.huggingface.co/models/${encodeURIComponent(org)}/${encodeURIComponent(name)}`;

  const { modelId: _modelId, ...forwardPayload } = payload;
  const body = JSON.stringify(forwardPayload);

  let hfResponse: Response;
  try {
    hfResponse = await fetchWithRetry(requestUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, image/png',
      },
      body,
    });
  } catch (err) {
    console.error('Failed to reach Hugging Face Inference API', err);
    return jsonResponse({ error: 'Failed to reach Hugging Face Inference API' }, 502);
  }

  const contentType = hfResponse.headers.get('content-type') ?? '';
  const normalizedContentType = contentType.toLowerCase();
  const status = hfResponse.status;

  if (!hfResponse.ok) {
    const errorText = await hfResponse.text();
    return jsonResponse({ error: errorText.slice(0, 200) }, status);
  }

  if (normalizedContentType.includes('application/json')) {
    const data = await hfResponse.json();
    return jsonResponse(typeof data === 'object' && data !== null ? (data as JsonRecord) : { error: 'Invalid response from Hugging Face' }, status);
  }

  const arrayBuffer = await hfResponse.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');

  return jsonResponse({ imageBase64: base64, contentType: contentType || 'image/png' }, status);
}

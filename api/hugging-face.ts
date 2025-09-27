const HUGGING_FACE_API_BASE = process.env.HUGGING_FACE_API_BASE ?? 'https://api-inference.huggingface.co/models';
const HUGGING_FACE_API_TOKEN = process.env.HUGGING_FACE_API_TOKEN ?? process.env.HUGGING_FACE_TOKEN;
const DEFAULT_MODEL = process.env.HUGGING_FACE_MODEL;

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const buildHuggingFaceUrl = (model: string) => {
  if (!model) {
    throw new Error('Hugging Face model was not provided.');
  }
  const base = HUGGING_FACE_API_BASE.replace(/\/$/, '');
  return `${base}/${encodeURIComponent(model)}`;
};

const extractErrorMessage = async (response: Response): Promise<string> => {
  const raw = await response.text();
  if (!raw) {
    return `Request failed with status ${response.status}.`;
  }

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') {
      return parsed;
    }
    if (parsed?.error) {
      if (typeof parsed.error === 'string') {
        return parsed.error;
      }
      if (parsed.error?.message && typeof parsed.error.message === 'string') {
        return parsed.error.message;
      }
    }
    if (parsed?.message && typeof parsed.message === 'string') {
      return parsed.message;
    }
    return raw;
  } catch {
    return raw;
  }
};

const forwardToHuggingFace = async (payload: Record<string, unknown>, model: string) => {
  if (!HUGGING_FACE_API_TOKEN) {
    throw new Error('Missing Hugging Face API token. Please configure HUGGING_FACE_API_TOKEN.');
  }

  const url = buildHuggingFaceUrl(model);
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${HUGGING_FACE_API_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      return response;
    }

    const message = await extractErrorMessage(response);
    if (!RETRYABLE_STATUS.has(response.status) || attempt === MAX_RETRIES - 1) {
      throw new HttpError(response.status, message);
    }

    attempt += 1;
    await wait(RETRY_DELAY_MS * attempt);
  }

  throw new HttpError(504, 'Failed to get a successful response from Hugging Face after multiple attempts.');
};

const normalizeBody = (req: any): Record<string, unknown> => {
  if (!req.body) {
    return {};
  }

  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      throw new Error('Invalid JSON body provided.');
    }
  }

  return req.body as Record<string, unknown>;
};

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader?.('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const body = normalizeBody(req);
    const { model = DEFAULT_MODEL, ...payload } = body;
    const resolvedModel = typeof model === 'string' ? model : DEFAULT_MODEL;

    if (!resolvedModel) {
      return res.status(400).json({ error: 'Missing Hugging Face model in request.' });
    }

    const response = await forwardToHuggingFace(payload, resolvedModel);
    const contentType = response.headers.get('content-type') ?? 'application/json';

    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader?.('Content-Type', contentType);
    res.status(response.status);

    if (contentType.includes('application/json')) {
      res.send?.(buffer.toString('utf-8')) ?? res.end?.(buffer.toString('utf-8'));
    } else {
      res.send?.(buffer) ?? res.end?.(buffer);
    }
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.status).json({ error: error.message });
    }

    const message = error instanceof Error ? error.message : 'Unexpected error while calling Hugging Face.';
    return res.status(500).json({ error: message });
  }
}

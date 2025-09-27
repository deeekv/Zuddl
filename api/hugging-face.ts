import { Readable } from 'node:stream';

const DEFAULT_MODEL = process.env.HUGGING_FACE_MODEL || 'stabilityai/sd-turbo';
const HF_API_URL = 'https://api-inference.huggingface.co/models';
const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 1500;

type IncomingBody = {
  inputs?: unknown;
  model?: string;
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
};

type VercelRequest = {
  method?: string;
  body?: any;
};

type VercelResponse = {
  status: (code: number) => VercelResponse;
  setHeader: (name: string, value: string | number | readonly string[]) => void;
  json: (body: unknown) => void;
  send: (body?: any) => void;
  end: () => void;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function getAuthToken(): string | undefined {
  return process.env.HUGGING_FACE_TOKEN || process.env.HUGGING_FACE_API_TOKEN;
}

async function parseRequestBody(req: VercelRequest): Promise<IncomingBody> {
  if (!req.body) {
    return {};
  }

  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch (error) {
      throw new Error('Invalid JSON payload.');
    }
  }

  if (typeof req.body === 'object') {
    return req.body as IncomingBody;
  }

  throw new Error('Unsupported request payload.');
}

function shouldRetry(status: number, message: string): boolean {
  if (status >= 500) {
    return true;
  }

  const lowerMessage = message.toLowerCase();
  return lowerMessage.includes('loading') || lowerMessage.includes('currently unavailable');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const token = getAuthToken();
    if (!token) {
      res.status(500).json({ error: 'Missing Hugging Face API token. Set HUGGING_FACE_TOKEN (or legacy HUGGING_FACE_API_TOKEN).' });
      return;
    }

    let requestBody: IncomingBody;
    try {
      requestBody = await parseRequestBody(req);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid request body.' });
      return;
    }

    const { inputs, model, parameters, ...rest } = requestBody;

    if (typeof inputs !== 'string' || !inputs.trim()) {
      res.status(400).json({ error: 'The "inputs" field with a non-empty prompt is required.' });
      return;
    }

    const payload = {
      inputs,
      parameters: parameters ?? {},
      options: { wait_for_model: true },
      ...rest,
    };

    const modelId = model || DEFAULT_MODEL;
    const url = `${HF_API_URL}/${encodeURIComponent(modelId)}`;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const contentType = response.headers.get('content-type') || '';

      if (!response.ok) {
        const errorText = await response.text();
        const errorMessage = (() => {
          try {
            const parsed = JSON.parse(errorText);
            return typeof parsed.error === 'string' ? parsed.error : errorText;
          } catch (_) {
            return errorText || `Hugging Face request failed with status ${response.status}.`;
          }
        })();

        if (attempt < MAX_ATTEMPTS && shouldRetry(response.status, errorMessage)) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }

        res.status(response.status).json({ error: errorMessage });
        return;
      }

      res.status(response.status);
      if (contentType) {
        res.setHeader('Content-Type', contentType);
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength) {
        res.setHeader('Content-Length', contentLength);
      }

      if (response.body) {
        const stream = Readable.fromWeb(response.body as any);
        stream.pipe(res as any);
      } else {
        const buffer = Buffer.from(await response.arrayBuffer());
        res.send(buffer);
      }
      return;
    }

    res.status(504).json({ error: 'Timed out while waiting for Hugging Face response.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error while contacting Hugging Face.';
    res.status(500).json({ error: message });
  }
}

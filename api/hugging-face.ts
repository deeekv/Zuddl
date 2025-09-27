const HF_API_BASE = 'https://api-inference.huggingface.co/models/';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

interface HuggingFaceRequestBody {
  prompt?: unknown;
  model?: unknown;
}

const parseBody = (body: any): HuggingFaceRequestBody => {
  if (!body) return {};
  if (typeof body === 'object') return body;
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  const body = parseBody(req.body);
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'stabilityai/sd-turbo';

  if (!prompt.trim()) {
    res.status(400).json({ error: 'Prompt is required.' });
    return;
  }

  const apiKey = process.env.HF_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Hugging Face API key is not configured.' });
    return;
  }

  const url = `${HF_API_BASE}${encodeURIComponent(model)}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept': '*/*',
        },
        body: JSON.stringify({ inputs: prompt }),
      });

      if (response.status === 503) {
        let errorPayload: any = null;
        try {
          errorPayload = await response.json();
        } catch {
          // ignore parsing errors for retry logic
        }

        const isLoading = typeof errorPayload?.error === 'string' && errorPayload.error.toLowerCase().includes('loading');
        if (isLoading && attempt < MAX_RETRIES - 1) {
          await delay(RETRY_DELAY_MS);
          continue;
        }

        res.status(503).json({ error: errorPayload?.error || 'The Hugging Face model is unavailable. Please try again later.' });
        return;
      }

      if (!response.ok) {
        let errorMessage = 'Hugging Face request failed.';
        try {
          const errorData = await response.json();
          if (typeof errorData?.error === 'string') {
            errorMessage = errorData.error;
          } else if (typeof errorData?.message === 'string') {
            errorMessage = errorData.message;
          }
        } catch {
          const fallbackText = await response.text();
          if (fallbackText) {
            errorMessage = fallbackText;
          }
        }

        res.status(response.status).json({ error: errorMessage });
        return;
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await response.json();
        res.setHeader('Content-Type', 'application/json');
        res.status(200).json({ type: 'text', data });
        return;
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const mimeType = contentType || 'image/png';

      res.setHeader('Content-Type', mimeType);
      res.status(200).send(buffer);
      return;
    } catch (error: any) {
      if (attempt === MAX_RETRIES - 1) {
        res.status(500).json({ error: error?.message || 'Unexpected error while contacting Hugging Face.' });
        return;
      }
      await delay(RETRY_DELAY_MS);
    }
  }
}

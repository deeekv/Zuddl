const HF_MODEL = 'stabilityai/sd-turbo';
const HF_API_URL = `https://api-inference.huggingface.co/models/${HF_MODEL}`;

export const generateHuggingFaceImage = async (prompt: string): Promise<string> => {
  const apiKey = process.env.HF_KEY;
  if (!apiKey) {
    throw new Error('Hugging Face API key is not configured.');
  }

  const response = await fetch(HF_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      Accept: 'image/png',
    },
    body: JSON.stringify({ inputs: prompt }),
  });

  if (!response.ok) {
    let errorDetails: string | undefined;
    try {
      const data = await response.json();
      if (typeof data?.error === 'string') {
        errorDetails = data.error;
      } else if (data) {
        errorDetails = JSON.stringify(data);
      }
    } catch {
      try {
        errorDetails = await response.text();
      } catch {
        errorDetails = undefined;
      }
    }

    let message = 'Hugging Face API request failed.';
    if (response.status === 503) {
      message = 'Hugging Face model is loading. Please try again in a moment.';
    } else if (response.status === 429) {
      message = 'Hugging Face API rate limit reached. Please wait and try again.';
    }

    if (errorDetails) {
      message += ` Details: ${errorDetails}`;
    }

    throw new Error(message);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  return buffer.toString('base64');
};

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  let prompt: string | undefined;
  try {
    if (typeof req.body === 'string') {
      ({ prompt } = JSON.parse(req.body));
    } else {
      ({ prompt } = req.body ?? {});
    }
  } catch {
    res.status(400).json({ error: 'Invalid JSON body.' });
    return;
  }

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    res.status(400).json({ error: 'Prompt is required.' });
    return;
  }

  try {
    const base64Image = await generateHuggingFaceImage(prompt);
    res.status(200).json({ image: base64Image });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to generate image with Hugging Face.';
    res.status(502).json({ error: message });
  }
}

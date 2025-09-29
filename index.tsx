
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Modality } from '@google/genai';

const parsePositiveNumber = (value: string | number | undefined, fallback: number) => {
  const numeric = typeof value === 'number' ? value : Number(value ?? fallback);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
};

const HUGGING_FACE_MAX_CONCURRENCY = Math.max(1, Math.floor(parsePositiveNumber(import.meta.env.VITE_HF_MAX_CONCURRENCY, 1)));
const HUGGING_FACE_DEFAULT_STEPS = Math.floor(parsePositiveNumber(import.meta.env.VITE_HF_STEPS, 5));
const HUGGING_FACE_DEFAULT_GUIDANCE = parsePositiveNumber(import.meta.env.VITE_HF_GUIDANCE, 1.5);
const CLAMPED_HF_STEPS = Math.min(6, Math.max(4, HUGGING_FACE_DEFAULT_STEPS));
const CLAMPED_HF_GUIDANCE = Math.min(2, Math.max(1, HUGGING_FACE_DEFAULT_GUIDANCE));
const isPreviewBuild = (import.meta.env.VITE_VERCEL_ENV ?? '').toLowerCase() === 'preview';

type ImageBatch = 'thumbnail' | 'inner';
type SlotStatus = 'idle' | 'queued' | 'generating' | 'retrying' | 'done' | 'error';

interface SlotGenerationState {
  status: SlotStatus;
  batch: ImageBatch;
  attempts: number;
  error?: string | null;
  message?: string | null;
}

const getGenAIClient = () => {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY as string | undefined;
  if (!apiKey) {
    throw new Error('Missing VITE_GEMINI_API_KEY environment variable. Please configure your Gemini API key.');
  }
  return new GoogleGenAI({ apiKey });
};

const ImagePreviewModal = ({ imageHistory, initialIndex, onClose, onDownload }) => {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);

  const handlePrev = () => {
    setCurrentIndex(prev => Math.max(0, prev - 1));
  };
  
  const handleNext = () => {
    setCurrentIndex(prev => Math.min(imageHistory.length - 1, prev + 1));
  };

  const currentImageSrc = imageHistory[currentIndex];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close-btn" onClick={onClose} aria-label="Close image preview">&times;</button>
        <div className="modal-image-wrapper">
          <img src={currentImageSrc} alt={`Image version ${currentIndex + 1}`} />
        </div>
        <div className="modal-controls">
          <button className="btn btn-secondary" onClick={handlePrev} disabled={currentIndex === 0}>Previous</button>
          <span>Version {currentIndex + 1} of {imageHistory.length}</span>
          <button className="btn btn-secondary" onClick={handleNext} disabled={currentIndex === imageHistory.length - 1}>Next</button>
          <button className="btn btn-primary" onClick={() => onDownload(currentImageSrc, currentIndex + 1)}>Download</button>
        </div>
      </div>
    </div>
  );
};

interface ImageConfig {
  key: string;
  title: string;
  width: number;
  height: number;
  aspectClass: string;
  isRemovable: boolean;
  type: ImageBatch;
}

const SUPPORTED_ASPECT_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16"];

const HUGGING_FACE_MODELS = [
  { value: 'stabilityai/sd-turbo', label: 'stabilityai/sd-turbo' },
  { value: 'runwayml/stable-diffusion-v1-5', label: 'runwayml/stable-diffusion-v1-5' },
  { value: 'stabilityai/stable-diffusion-2-1', label: 'stabilityai/stable-diffusion-2-1' },
  { value: 'stabilityai/sdxl-turbo', label: 'stabilityai/sdxl-turbo (may require access)' },
];

const findClosestSupportedRatio = (width: number, height: number): string => {
  const targetRatio = width / height;
  
  const ratioMap = SUPPORTED_ASPECT_RATIOS.map(r => {
    const [w, h] = r.split(':').map(Number);
    return { ratioString: r, decimal: w / h };
  });

  let closest = ratioMap[0];
  let minDiff = Math.abs(targetRatio - closest.decimal);

  for (let i = 1; i < ratioMap.length; i++) {
    const diff = Math.abs(targetRatio - ratioMap[i].decimal);
    if (diff < minDiff) {
      minDiff = diff;
      closest = ratioMap[i];
    }
  }

  return closest.ratioString;
};

const parseErrorMessage = (err: unknown): string => {
  if (typeof err === 'string') {
    return err;
  }
  if (err && typeof err === 'object' && 'error' in err && typeof (err as { error?: unknown }).error === 'string') {
    return (err as { error: string }).error;
  }
  if (err instanceof Error) {
    const message = err.message;
    // Attempt to extract the user-facing message part from a JSON string.
    const match = message.match(/"message":\s*"(.*?)"/);
    if (match && match[1]) {
      return match[1]; // Return the extracted message.
    }
    return message; // Fallback to the full message if regex fails.
  }
  return 'An unknown error occurred while generating images.';
};


const App = () => {
  const [blogContent, setBlogContent] = useState('');
  const [images, setImages] = useState<Record<string, string[]>>({});
  const [currentVersions, setCurrentVersions] = useState<Record<string, number>>({});
  const [modificationPrompts, setModificationPrompts] = useState<Record<string, string>>({
    thumbnail16x9: '',
    thumbnailAlt16x9: '',
    innerImage1: '',
    innerImage2: '',
  });
  const [slotStatuses, setSlotStatuses] = useState<Record<string, SlotGenerationState>>({
    thumbnail16x9: { status: 'idle', batch: 'thumbnail', attempts: 0, error: null, message: null },
    thumbnailAlt16x9: { status: 'idle', batch: 'thumbnail', attempts: 0, error: null, message: null },
    innerImage1: { status: 'idle', batch: 'inner', attempts: 0, error: null, message: null },
    innerImage2: { status: 'idle', batch: 'inner', attempts: 0, error: null, message: null },
  });
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [innerStarted, setInnerStarted] = useState(false);
  const [innerSkipped, setInnerSkipped] = useState(false);
  const [showSkipInnerLink, setShowSkipInnerLink] = useState(false);
  const slotStatusesRef = useRef(slotStatuses);
  const skipInnerRef = useRef(false);
  const [regenerating, setRegenerating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imageProvider, setImageProvider] = useState<'google' | 'huggingFace'>('google');
  const [selectedHuggingFaceModel, setSelectedHuggingFaceModel] = useState('stabilityai/sd-turbo');
  const [selectedModel, setSelectedModel] = useState('imagen-4.0-generate-001');
  const [modalState, setModalState] = useState<{ key: string; history: string[]; index: number } | null>(null);
  const isHuggingFaceProvider = imageProvider === 'huggingFace';
  const hasFailures = useMemo(() => Object.values(slotStatuses).some(state => state.status === 'error'), [slotStatuses]);

  useEffect(() => {
    slotStatusesRef.current = slotStatuses;
  }, [slotStatuses]);

  useEffect(() => {
    setSlotStatuses(prev => {
      const next: Record<string, SlotGenerationState> = {};
      imageConfigs.forEach(config => {
        const existing = prev[config.key];
        next[config.key] = existing
          ? { ...existing, batch: config.type }
          : { status: 'idle', batch: config.type, attempts: 0, error: null, message: null };
      });
      return next;
    });
  }, [imageConfigs]);

  const requestHuggingFaceImage = async (
    payload: Record<string, unknown>,
    callbacks?: {
      onAttemptStart?: (attempt: number) => void;
      onRetry?: (nextAttempt: number, delayMs: number) => void;
    },
  ) => {
    const maxAttempts = 3;
    const retryDelays = [0, 1500, 2500];

    const sendRequest = async (attempt: number): Promise<{ base64: string; contentType: string }> => {
      callbacks?.onAttemptStart?.(attempt);

      const response = await fetch('/api/hugging-face', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...payload, modelId: selectedHuggingFaceModel }),
      });

      const rawBody = await response.text();
      let parsedBody: any = null;
      if (rawBody) {
        try {
          parsedBody = JSON.parse(rawBody);
        } catch (parseErr) {
          console.warn('Failed to parse Hugging Face response as JSON', parseErr);
        }
      }

      const lowerBody = rawBody ? rawBody.toLowerCase() : '';
      if (response.status === 503 && lowerBody.includes('loading')) {
        if (attempt < maxAttempts) {
          const delay = retryDelays[attempt] ?? retryDelays[retryDelays.length - 1];
          callbacks?.onRetry?.(attempt + 1, delay);
          await new Promise(resolve => setTimeout(resolve, delay));
          return sendRequest(attempt + 1);
        }
        const message = typeof parsedBody?.error === 'string'
          ? parsedBody.error
          : 'Model is loading. Please retry in a moment.';
        throw new Error(message);
      }

      if (!response.ok) {
        const message = typeof parsedBody?.error === 'string'
          ? parsedBody.error
          : rawBody
            ? rawBody.slice(0, 200)
            : 'Failed to generate image with Hugging Face.';

        if (response.status === 404) {
          throw new Error('Model not found or gated — check the model page on Hugging Face and accept terms if required.');
        }

        throw new Error(message);
      }

      if (!parsedBody || typeof parsedBody !== 'object') {
        throw new Error('Invalid response from Hugging Face.');
      }

      const base64 = typeof (parsedBody as { imageBase64?: string }).imageBase64 === 'string'
        ? (parsedBody as { imageBase64: string }).imageBase64
        : typeof (parsedBody as { image?: string }).image === 'string'
          ? (parsedBody as { image: string }).image
          : null;

      if (!base64) {
        throw new Error('Invalid response from Hugging Face.');
      }

      const contentType = typeof (parsedBody as { contentType?: string }).contentType === 'string'
        ? (parsedBody as { contentType: string }).contentType
        : 'image/png';

      return { base64, contentType };
    };

    return sendRequest(1);
  };
  
  const initialImageConfigs: ImageConfig[] = [
    { key: 'thumbnail16x9', title: 'Thumbnail', width: 1280, height: 720, aspectClass: 'aspect-16-9', isRemovable: false, type: 'thumbnail' },
    { key: 'thumbnailAlt16x9', title: 'Thumbnail', width: 1024, height: 576, aspectClass: 'aspect-16-9', isRemovable: false, type: 'thumbnail' },
    { key: 'innerImage1', title: 'Inner Image', width: 812, height: 608, aspectClass: 'aspect-4-3', isRemovable: false, type: 'inner' },
    { key: 'innerImage2', title: 'Inner Image', width: 812, height: 608, aspectClass: 'aspect-4-3', isRemovable: false, type: 'inner' },
  ];
  const [imageConfigs, setImageConfigs] = useState<ImageConfig[]>(initialImageConfigs);

  const STYLE_PROMPT = `
  **Style Guide:** Create clean, modern, and product-focused images for a B2B SaaS blog. The aesthetic is centered on stylized UI mockups, data visualizations, and well-integrated human elements.

  **CRITICAL CONSTRAINT: Each generated image must be STRICTLY MONOCHROMATIC.** You MUST select ONE SINGLE color family from the list below for the entire image. Do not mix colors from different families.

  **ABSOLUTELY NO GRADIENTS.** Use only solid blocks of color from the chosen palette. The final output must be a flat, clean, vector-style image using only the specified shades. Any deviation from the monochromatic rule or inclusion of gradients will be considered a failure.

  - **Core Composition:** Focus on clean, vector-based UI elements and product mockups (dashboards, charts, mobile screens, feature callouts). Use card-based layouts with rounded corners and layer elements for depth.

  - **Human Elements:** Integrate human elements in one of two ways:
    1. **Full-Color Photos in UI:** Realistic photos of diverse professionals are ONLY allowed when they appear *inside* a UI element (e.g., a video call window, a profile avatar).
    2. **Styled Cutouts:** When layering cutout people or hands over abstract backgrounds, apply a monochromatic color overlay (duotone effect) using a darker shade from the chosen palette.

  - **Illustrations & UI:** Use minimalist iconography. Small decorative elements like sparkles and simple geometric shapes are acceptable if they follow the monochromatic rule.

  - **Color Palette:** **MANDATORY**: Each image must strictly use ONE of the following monochromatic color families. Use lighter shades for backgrounds and darker shades for foregrounds.
    - **Aubergine Purple:** #EFE6FF, #D8C3FA, #AD7FF5, #843DF5, #5C16CC, #320972
    - **Spirulina Blue:** #E0ECFF, #BAD6FF, #75ACFF, #3E8BFF, #0E54BD, #032C6B
    - **Mint Green:** #DCF2EF, #B7EDE3, #71D9C6, #33C0A7, #129981, #075042
    - **Tomato Red:** #FFEBEB, #FAC5C5, #F58E8E, #F45757, #CB2727, #761414
    - **Candy Floss Pink:** #FFE8FE, #F8CAF9, #F097EC, #F05DEA, #B614AF, #800B7B

  - **Texture & Finish:** Apply a subtle, uniform grain or halftone texture over the entire image.

  - **Overall Feel:** Product-centric, data-driven, clean, and user-friendly.
  `;

  const logRequestTelemetry = (batch: ImageBatch, index: number, attempt: number, ms: number, status: 'ok' | 'error') => {
    if (!isPreviewBuild) return;
    console.log(JSON.stringify({ batch: batch === 'thumbnail' ? 'thumb' : 'inner', index, attempt, ms, status }));
  };

  const runHuggingFaceSlot = async (config: ImageConfig, batch: ImageBatch, basePrompt: string, index: number) => {
    const ratio = findClosestSupportedRatio(config.width, config.height);
    const prompt = `${basePrompt} Generate a single image that fits an aspect ratio of ${ratio}.`;
    const startTime = performance.now();
    let attempts = 0;

    try {
      const { base64, contentType } = await requestHuggingFaceImage(
        {
          prompt,
          inputs: prompt,
          width: config.width,
          height: config.height,
          aspectRatio: ratio,
          parameters: {
            width: config.width,
            height: config.height,
            guidance_scale: CLAMPED_HF_GUIDANCE,
            num_inference_steps: CLAMPED_HF_STEPS,
          },
        },
        {
          onAttemptStart: attempt => {
            attempts = attempt;
            setSlotStatuses(prev => {
              const existing = prev[config.key] ?? { status: 'idle', batch: config.type, attempts: 0, error: null, message: null };
              return {
                ...prev,
                [config.key]: { ...existing, status: 'generating', attempts: attempt, error: null, message: null },
              };
            });
          },
          onRetry: (nextAttempt, delayMs) => {
            setSlotStatuses(prev => {
              const existing = prev[config.key] ?? { status: 'idle', batch: config.type, attempts, error: null, message: null };
              return {
                ...prev,
                [config.key]: {
                  ...existing,
                  status: 'retrying',
                  attempts,
                  error: null,
                  message: `Retrying in ${(delayMs / 1000).toFixed(1)}s...`,
                },
              };
            });
          },
        },
      );

      const mimeType = contentType.includes('/') ? contentType : 'image/png';
      const imageSrc = `data:${mimeType};base64,${base64}`;

      setImages(prev => ({ ...prev, [config.key]: [imageSrc] }));
      setCurrentVersions(prev => ({ ...prev, [config.key]: 0 }));
      setSlotStatuses(prev => {
        const existing = prev[config.key] ?? { status: 'idle', batch: config.type, attempts, error: null, message: null };
        return {
          ...prev,
          [config.key]: { ...existing, status: 'done', attempts, error: null, message: null },
        };
      });

      logRequestTelemetry(batch, index, attempts, Math.round(performance.now() - startTime), 'ok');
    } catch (err) {
      const message = parseErrorMessage(err);
      const elapsed = Math.round(performance.now() - startTime);
      setSlotStatuses(prev => {
        const existing = prev[config.key] ?? { status: 'idle', batch: config.type, attempts: attempts || 1, error: null, message: null };
        return {
          ...prev,
          [config.key]: {
            ...existing,
            status: 'error',
            attempts: attempts || existing.attempts || 1,
            error: message,
            message: null,
          },
        };
      });
      logRequestTelemetry(batch, index, attempts || 1, elapsed, 'error');
    }
  };

  const runGoogleSlot = async (
    config: ImageConfig,
    basePrompt: string,
    index: number,
    aiClient: GoogleGenAI,
  ) => {
    const ratio = findClosestSupportedRatio(config.width, config.height);
    const prompt = `${basePrompt} Generate a single image that fits an aspect ratio of ${ratio}.`;

    setSlotStatuses(prev => {
      const existing = prev[config.key] ?? { status: 'idle', batch: config.type, attempts: 0, error: null, message: null };
      return {
        ...prev,
        [config.key]: {
          ...existing,
          status: 'generating',
          attempts: Math.max(existing.attempts + 1, 1),
          error: null,
          message: null,
        },
      };
    });

    try {
      const response = await aiClient.models.generateImages({
        model: 'imagen-4.0-generate-001',
        prompt,
        config: { numberOfImages: 1, outputMimeType: 'image/png', aspectRatio: ratio },
      });
      const imageBytes = response.generatedImages?.[0]?.image?.imageBytes;
      if (!imageBytes) {
        throw new Error('Image generation failed to return an image.');
      }

      const imageSrc = `data:image/png;base64,${imageBytes}`;
      setImages(prev => ({ ...prev, [config.key]: [imageSrc] }));
      setCurrentVersions(prev => ({ ...prev, [config.key]: 0 }));
      setSlotStatuses(prev => {
        const existing = prev[config.key] ?? { status: 'idle', batch: config.type, attempts: 1, error: null, message: null };
        return {
          ...prev,
          [config.key]: { ...existing, status: 'done', error: null, message: null },
        };
      });
    } catch (err) {
      const message = parseErrorMessage(err);
      setSlotStatuses(prev => {
        const existing = prev[config.key] ?? { status: 'idle', batch: config.type, attempts: 1, error: null, message: null };
        return {
          ...prev,
          [config.key]: { ...existing, status: 'error', error: message, message: null },
        };
      });
      setError(message);
    }
  };

  const runBatchForConfigs = async (
    configs: ImageConfig[],
    batch: ImageBatch,
    basePrompt: string,
    aiClient?: GoogleGenAI,
  ) => {
    if (!configs.length) return;

    let cursor = 0;
    const tasks = configs.map((config, index) => async () => {
      if (batch === 'inner' && skipInnerRef.current) {
        setSlotStatuses(prev => {
          const existing = prev[config.key] ?? { status: 'idle', batch: config.type, attempts: 0, error: null, message: null };
          return {
            ...prev,
            [config.key]: { ...existing, message: 'Skipped by user' },
          };
        });
        return;
      }

      if (isHuggingFaceProvider) {
        await runHuggingFaceSlot(config, batch, basePrompt, index);
      } else if (aiClient) {
        await runGoogleSlot(config, basePrompt, index, aiClient);
      }
    });

    if (isHuggingFaceProvider) {
      const workerCount = Math.min(HUGGING_FACE_MAX_CONCURRENCY, tasks.length);
      const runners = Array.from({ length: workerCount }, () => (async () => {
        while (true) {
          const current = cursor++;
          if (current >= tasks.length) {
            break;
          }
          await tasks[current]();
          if (batch === 'inner' && skipInnerRef.current) {
            break;
          }
        }
      })());
      await Promise.all(runners);
    } else {
      for (const task of tasks) {
        await task();
        if (batch === 'inner' && skipInnerRef.current) {
          break;
        }
      }
    }
  };

  const generateInitialImages = async () => {
    if (!blogContent.trim()) {
      setError('Please paste your blog content first.');
      return;
    }

    setError(null);
    skipInnerRef.current = false;
    setInnerSkipped(false);
    setInnerStarted(false);
    setShowSkipInnerLink(false);
    setImages({});
    setCurrentVersions({});

    const thumbnailConfigs = imageConfigs.filter(config => config.type === 'thumbnail');
    const innerConfigs = imageConfigs.filter(config => config.type === 'inner');

    setSlotStatuses(() => {
      const next: Record<string, SlotGenerationState> = {};
      imageConfigs.forEach(config => {
        next[config.key] = {
          status: 'queued',
          batch: config.type,
          attempts: 0,
          error: null,
          message: config.type === 'inner' ? 'Waiting for thumbnails...' : null,
        };
      });
      return next;
    });

    const basePrompt = `${STYLE_PROMPT} Based on the following blog content, generate images for a tech blog. Blog Content:"${blogContent}"`;
    setIsBatchRunning(true);

    const aiClient = isHuggingFaceProvider ? null : getGenAIClient();

    try {
      await runBatchForConfigs(thumbnailConfigs, 'thumbnail', basePrompt, aiClient ?? undefined);

      const thumbnailErrors = thumbnailConfigs.some(config => slotStatusesRef.current[config.key]?.status === 'error');
      if (thumbnailErrors) {
        setError('Some thumbnails failed. Use Retry failed to try again.');
        return;
      }

      if (innerConfigs.length > 0) {
        setShowSkipInnerLink(true);
        setInnerStarted(true);
        await runBatchForConfigs(innerConfigs, 'inner', basePrompt, aiClient ?? undefined);
        setShowSkipInnerLink(false);

        if (skipInnerRef.current) {
          setError(null);
          return;
        }

        const innerErrors = innerConfigs.some(config => slotStatusesRef.current[config.key]?.status === 'error');
        if (innerErrors) {
          setError('Some inner images failed. Use Retry failed to re-run them.');
          return;
        }
      }

      setError(null);
    } catch (err) {
      console.error(err);
      setError(parseErrorMessage(err));
    } finally {
      setIsBatchRunning(false);
    }
  };

  const retryFailedSlots = async () => {
    const failedConfigs = imageConfigs.filter(config => slotStatuses[config.key]?.status === 'error');
    if (failedConfigs.length === 0) {
      return;
    }

    if (!blogContent.trim()) {
      setError('Please paste your blog content first.');
      return;
    }

    setError(null);
    skipInnerRef.current = false;
    setInnerSkipped(false);
    setShowSkipInnerLink(false);
    setIsBatchRunning(true);

    const basePrompt = `${STYLE_PROMPT} Based on the following blog content, generate images for a tech blog. Blog Content:"${blogContent}"`;
    const aiClient = isHuggingFaceProvider ? null : getGenAIClient();

    const failedThumbnails = failedConfigs.filter(config => config.type === 'thumbnail');
    const failedInner = failedConfigs.filter(config => config.type === 'inner');

    try {
      if (failedThumbnails.length > 0) {
        setSlotStatuses(prev => {
          const next = { ...prev };
          failedThumbnails.forEach(config => {
            next[config.key] = {
              status: 'queued',
              batch: config.type,
              attempts: 0,
              error: null,
              message: null,
            };
          });
          return next;
        });

        await runBatchForConfigs(failedThumbnails, 'thumbnail', basePrompt, aiClient ?? undefined);
      }

      const thumbnailsStillFailing = failedThumbnails.some(config => slotStatusesRef.current[config.key]?.status === 'error');

      if (!thumbnailsStillFailing && failedInner.length > 0) {
        setSlotStatuses(prev => {
          const next = { ...prev };
          failedInner.forEach(config => {
            next[config.key] = {
              status: 'queued',
              batch: config.type,
              attempts: 0,
              error: null,
              message: null,
            };
          });
          return next;
        });

        setShowSkipInnerLink(true);
        setInnerStarted(true);
        await runBatchForConfigs(failedInner, 'inner', basePrompt, aiClient ?? undefined);
        setShowSkipInnerLink(false);

        if (skipInnerRef.current) {
          setError(null);
          return;
        }
      }

      const remainingFailures = failedConfigs.some(config => slotStatusesRef.current[config.key]?.status === 'error');
      setError(remainingFailures ? 'Some images are still failing. Adjust your prompts and try again.' : null);
    } catch (err) {
      console.error(err);
      setError(parseErrorMessage(err));
    } finally {
      setIsBatchRunning(false);
    }
  };

  const handleSkipInner = () => {
    if (!innerStarted) {
      return;
    }
    skipInnerRef.current = true;
    setInnerSkipped(true);
    setShowSkipInnerLink(false);
  };

  const regenerateImage = async (imageKey: string) => {
    const modificationPrompt = modificationPrompts[imageKey];
    if (!modificationPrompt.trim()) {
        setError(`Please provide a modification instruction for this image.`);
        return;
    }
    setError(null);
    setRegenerating(imageKey);

    const config = imageConfigs.find(c => c.key === imageKey);
    if (!config) {
        setError("Could not find configuration for the image.");
        setRegenerating(null);
        return;
    }
    const aspectRatio = findClosestSupportedRatio(config.width, config.height);
    let attempts = 0;

    setSlotStatuses(prev => {
      const existing = prev[imageKey] ?? { status: 'idle', batch: config.type, attempts: 0, error: null, message: null };
      return {
        ...prev,
        [imageKey]: { ...existing, status: 'generating', attempts: Math.max(existing.attempts + 1, 1), error: null, message: null },
      };
    });

    try {
        let newImageSrc: string | null = null;

        if (isHuggingFaceProvider) {
            const prompt = `${STYLE_PROMPT} Regenerate an image for a tech blog based on the original content and a modification request.
            Original Blog Content: "${blogContent}"
            Modification Request: "${modificationPrompt}"
            The required aspect ratio is ${aspectRatio}.`;

            const { base64, contentType } = await requestHuggingFaceImage({
                prompt,
                inputs: prompt,
                width: config.width,
                height: config.height,
                aspectRatio,
                parameters: {
                  width: config.width,
                  height: config.height,
                  guidance_scale: CLAMPED_HF_GUIDANCE,
                  num_inference_steps: CLAMPED_HF_STEPS,
                },
            }, {
              onAttemptStart: attempt => {
                attempts = attempt;
                setSlotStatuses(prev => {
                  const existing = prev[imageKey] ?? { status: 'idle', batch: config.type, attempts: 0, error: null, message: null };
                  return {
                    ...prev,
                    [imageKey]: { ...existing, status: 'generating', attempts: attempt, error: null, message: null },
                  };
                });
              },
              onRetry: (_nextAttempt, delayMs) => {
                setSlotStatuses(prev => {
                  const existing = prev[imageKey] ?? { status: 'idle', batch: config.type, attempts, error: null, message: null };
                  return {
                    ...prev,
                    [imageKey]: {
                      ...existing,
                      status: 'retrying',
                      attempts,
                      error: null,
                      message: `Retrying in ${(delayMs / 1000).toFixed(1)}s...`,
                    },
                  };
                });
              },
            });
            const mimeType = contentType.includes('/') ? contentType : 'image/png';
            newImageSrc = `data:${mimeType};base64,${base64}`;
        } else {
            const ai = getGenAIClient();

            if (selectedModel === 'gemini-2.5-flash-image-preview') {
                const currentImageHistory = images[imageKey];
                const currentImageIndex = currentVersions[imageKey];
                if (!currentImageHistory || currentImageIndex === undefined) {
                    throw new Error("Cannot edit an image that doesn't exist.");
                }
                const currentImageSrc = currentImageHistory[currentImageIndex];
                const base64Data = currentImageSrc.split(',')[1];

                const imagePart = { inlineData: { data: base64Data, mimeType: 'image/png' } };
                const textPart = { text: modificationPrompt };

                const response = await ai.models.generateContent({
                    model: 'gemini-2.5-flash-image-preview',
                    contents: { parts: [imagePart, textPart] },
                    config: { responseModalities: [Modality.IMAGE, Modality.TEXT] },
                });

                const imagePartResponse = response.candidates?.[0]?.content?.parts?.find(part => part.inlineData);
                if (imagePartResponse?.inlineData) {
                    newImageSrc = `data:image/png;base64,${imagePartResponse.inlineData.data}`;
                } else {
                    throw new Error("The editing model did not return an image. Please try a different prompt.");
                }

            } else { // 'imagen-4.0-generate-001'
                const prompt = `${STYLE_PROMPT} Regenerate an image for a tech blog based on the original content and a modification request.
            Original Blog Content: "${blogContent}"
            Modification Request: "${modificationPrompt}"
            The required aspect ratio is ${aspectRatio}.`;

                const response = await ai.models.generateImages({
                    model: selectedModel, prompt, config: { numberOfImages: 1, outputMimeType: 'image/png', aspectRatio },
                });
                newImageSrc = `data:image/png;base64,${response.generatedImages[0].image.imageBytes}`;
            }
        }

        if (newImageSrc) {
            setImages(prev => {
                const history = prev[imageKey] || [];
                // Truncate history if we have undone changes
                const newHistory = history.slice(0, (currentVersions[imageKey] ?? 0) + 1);
                return { ...prev, [imageKey]: [...newHistory, newImageSrc as string] };
            });
            setCurrentVersions(prev => ({...prev, [imageKey]: (prev[imageKey] ?? -1) + 1}));
            setSlotStatuses(prev => {
              const fallback: SlotGenerationState = { status: 'idle', batch: config.type, attempts: 0, error: null, message: null };
              const existing = prev[imageKey] ?? fallback;
              const nextAttempts = attempts || existing.attempts || 1;
              return {
                ...prev,
                [imageKey]: { ...existing, status: 'done', attempts: nextAttempts, error: null, message: null },
              };
            });
        }

    } catch (err) {
        console.error(err);
        const message = parseErrorMessage(err);
        setError(message);
        setSlotStatuses(prev => {
          const existing = prev[imageKey] ?? { status: 'idle', batch: config.type, attempts: attempts || 1, error: null, message: null };
          return {
            ...prev,
            [imageKey]: { ...existing, status: 'error', attempts: attempts || existing.attempts || 1, error: message, message: null },
          };
        });
    } finally {
        setRegenerating(null);
    }
  };

  const generateSingleImage = async (imageKey: string) => {
    if (!blogContent.trim()) {
      setError('Please paste your blog content first.');
      return;
    }
    setError(null);
    setRegenerating(imageKey);

    const config = imageConfigs.find(c => c.key === imageKey);
    if (!config) {
        setError("Could not find configuration for the image.");
        setRegenerating(null);
        return;
    }
    const aspectRatio = findClosestSupportedRatio(config.width, config.height);
    let attempts = 0;

    setSlotStatuses(prev => {
      const existing = prev[imageKey] ?? { status: 'idle', batch: config.type, attempts: 0, error: null, message: null };
      return {
        ...prev,
        [imageKey]: { ...existing, status: 'generating', attempts: Math.max(existing.attempts + 1, 1), error: null, message: null },
      };
    });

    try {
        if (isHuggingFaceProvider) {
            const prompt = `${STYLE_PROMPT} Based on the following blog content, generate an image for a tech blog. Blog Content: "${blogContent}"`;
            const { base64, contentType } = await requestHuggingFaceImage({
                prompt,
                inputs: prompt,
                width: config.width,
                height: config.height,
                aspectRatio,
                parameters: {
                  width: config.width,
                  height: config.height,
                  guidance_scale: CLAMPED_HF_GUIDANCE,
                  num_inference_steps: CLAMPED_HF_STEPS,
                },
            }, {
              onAttemptStart: attempt => {
                attempts = attempt;
                setSlotStatuses(prev => {
                  const existing = prev[imageKey] ?? { status: 'idle', batch: config.type, attempts: 0, error: null, message: null };
                  return {
                    ...prev,
                    [imageKey]: { ...existing, status: 'generating', attempts: attempt, error: null, message: null },
                  };
                });
              },
              onRetry: (_nextAttempt, delayMs) => {
                setSlotStatuses(prev => {
                  const existing = prev[imageKey] ?? { status: 'idle', batch: config.type, attempts, error: null, message: null };
                  return {
                    ...prev,
                    [imageKey]: {
                      ...existing,
                      status: 'retrying',
                      attempts,
                      error: null,
                      message: `Retrying in ${(delayMs / 1000).toFixed(1)}s...`,
                    },
                  };
                });
              },
            });
            const mimeType = contentType.includes('/') ? contentType : 'image/png';
            const newImageSrc = `data:${mimeType};base64,${base64}`;

            setImages(prev => ({
                ...prev,
                [imageKey]: [newImageSrc]
            }));
            setCurrentVersions(prev => ({...prev, [imageKey]: 0}));
            setSlotStatuses(prev => {
              const existing = prev[imageKey] ?? { status: 'idle', batch: config.type, attempts, error: null, message: null };
              return {
                ...prev,
                [imageKey]: { ...existing, status: 'done', attempts: attempts || existing.attempts || 1, error: null, message: null },
              };
            });
            return;
        }

        const ai = getGenAIClient();
        const prompt = `${STYLE_PROMPT} Based on the following blog content, generate an image for a tech blog. Blog Content: "${blogContent}"`;

        const response = await ai.models.generateImages({
            model: 'imagen-4.0-generate-001',
            prompt,
            config: { numberOfImages: 1, outputMimeType: 'image/png', aspectRatio },
        });

        if (response.generatedImages && response.generatedImages.length > 0) {
            const newImageSrc = `data:image/png;base64,${response.generatedImages[0].image.imageBytes}`;
            setImages(prev => ({
                ...prev,
                [imageKey]: [newImageSrc]
            }));
            setCurrentVersions(prev => ({...prev, [imageKey]: 0}));
            setSlotStatuses(prev => {
              const existing = prev[imageKey] ?? { status: 'idle', batch: config.type, attempts: 1, error: null, message: null };
              return {
                ...prev,
                [imageKey]: { ...existing, status: 'done', error: null, message: null },
              };
            });
        } else {
            throw new Error("Image generation failed to return an image.");
        }

    } catch (err) {
        console.error(err);
        const message = parseErrorMessage(err);
        setError(message);
        setSlotStatuses(prev => {
          const existing = prev[imageKey] ?? { status: 'idle', batch: config.type, attempts: attempts || 1, error: null, message: null };
          return {
            ...prev,
            [imageKey]: { ...existing, status: 'error', attempts: attempts || existing.attempts || 1, error: message, message: null },
          };
        });
    } finally {
        setRegenerating(null);
    }
  };
  
  const handlePromptChange = (e: React.ChangeEvent<HTMLInputElement>, key: string) => {
      setModificationPrompts(prev => ({ ...prev, [key]: e.target.value }));
  };

  const handleDimensionChange = (key: string, dim: 'width' | 'height', value: string) => {
    const numValue = parseInt(value, 10);
    if (isNaN(numValue) || numValue <= 0) return;
    setImageConfigs(prev => prev.map(c => c.key === key ? { ...c, [dim]: numValue } : c));
  };
  
  const addInnerImage = () => {
    const newKey = `innerImage${Date.now()}`;
    const newImage: ImageConfig = {
      key: newKey,
      title: 'Inner Image',
      width: 812,
      height: 608,
      aspectClass: 'aspect-4-3',
      isRemovable: true,
      type: 'inner',
    };
    setImageConfigs(prev => [...prev, newImage]);
    setModificationPrompts(prev => ({...prev, [newKey]: ''}));
    setSlotStatuses(prev => ({
      ...prev,
      [newKey]: { status: 'idle', batch: 'inner', attempts: 0, error: null, message: null },
    }));
  };

  const removeInnerImage = (keyToRemove: string) => {
    setImageConfigs(prev => prev.filter(c => c.key !== keyToRemove));
    // Clean up state
    setImages(prev => {
      const newState = {...prev};
      delete newState[keyToRemove];
      return newState;
    });
    setCurrentVersions(prev => {
      const newState = {...prev};
      delete newState[keyToRemove];
      return newState;
    });
    setModificationPrompts(prev => {
      const newState = {...prev};
      delete newState[keyToRemove];
      return newState;
    });
    setSlotStatuses(prev => {
      const next = { ...prev };
      delete next[keyToRemove];
      return next;
    });
  };

  const handleUndo = (key: string) => {
    setCurrentVersions(prev => ({...prev, [key]: Math.max(0, prev[key] - 1)}));
  };

  const handleDownload = (key: string) => {
    const history = images[key];
    const currentIndex = currentVersions[key];
    if (!history || currentIndex === undefined) return;

    const imageSrc = history[currentIndex];
    const version = currentIndex + 1;
    const link = document.createElement('a');
    link.href = imageSrc;
    link.download = `${key}-v${version}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleModalDownload = (src: string, version: number) => {
    const key = modalState?.key || 'downloaded-image';
    const link = document.createElement('a');
    link.href = src;
    link.download = `${key}-v${version}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="container">
       {modalState && (
        <ImagePreviewModal
          imageHistory={modalState.history}
          initialIndex={modalState.index}
          onClose={() => setModalState(null)}
          onDownload={handleModalDownload}
        />
      )}
      <h1>Zuddl Blog Thumbnail Generator</h1>
      <div className="main-controls">
        <div className="model-selector-wrapper">
            <label htmlFor="provider-selector">Image Provider</label>
            <div className="select-container">
              <select
                  id="provider-selector"
                  className="model-selector"
                  value={imageProvider}
                  onChange={e => setImageProvider(e.target.value as 'google' | 'huggingFace')}
                  disabled={isBatchRunning || !!regenerating}
              >
                  <option value="google">Google Gemini</option>
                  <option value="huggingFace">Hugging Face</option>
              </select>
            </div>
        </div>
        {isHuggingFaceProvider && (
          <div className="model-selector-wrapper">
            <label htmlFor="hugging-face-model-selector">Hugging Face Models</label>
            <div className="select-container">
              <select
                id="hugging-face-model-selector"
                className="model-selector"
                value={selectedHuggingFaceModel}
                onChange={e => setSelectedHuggingFaceModel(e.target.value)}
                disabled={isBatchRunning || !!regenerating}
              >
                {HUGGING_FACE_MODELS.map(model => (
                  <option key={model.value} value={model.value}>{model.label}</option>
                ))}
              </select>
            </div>
          </div>
        )}
        {!isHuggingFaceProvider && (
          <div className="model-selector-wrapper">
              <label htmlFor="model-selector">Regeneration Model</label>
              <div className="select-container">
                <select
                    id="model-selector"
                    className="model-selector"
                    value={selectedModel}
                    onChange={e => setSelectedModel(e.target.value)}
                    disabled={isBatchRunning || !!regenerating}
                >
                    <option value="imagen-4.0-generate-001">Imagen 4.0 (Generate)</option>
                    <option value="gemini-2.5-flash-image-preview">Gemini 2.5 Flash (Edit)</option>
                </select>
              </div>
          </div>
        )}
        <textarea
          className="blog-input"
          value={blogContent}
          onChange={(e) => setBlogContent(e.target.value)}
          placeholder="Paste your blog document info here..."
          aria-label="Blog Content Input"
        />
        <div className="batch-controls">
          <button className="btn btn-primary" onClick={generateInitialImages} disabled={isBatchRunning || !!regenerating}>
            {isBatchRunning ? <><div className="spinner"></div><span>Generating...</span></> : 'Generate Thumbnails'}
          </button>
          <button
            className="btn btn-secondary"
            onClick={retryFailedSlots}
            disabled={!hasFailures || isBatchRunning || !!regenerating}
          >
            Retry failed
          </button>
          {showSkipInnerLink && !innerSkipped && (
            <button
              type="button"
              className="skip-inner-link"
              onClick={handleSkipInner}
              disabled={!!regenerating}
            >
              Skip inner images
            </button>
          )}
        </div>
      </div>
      {innerSkipped && <p className="info-message">Inner image batch skipped.</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="image-grid">
        {imageConfigs.map(({ key, title, width, height, aspectClass, isRemovable, type }) => {
          const history = images[key] || [];
          const currentIndex = currentVersions[key] ?? -1;
          const currentImageSrc = history[currentIndex];
          const canUndo = currentIndex > 0;
          const slotState = slotStatuses[key] ?? { status: 'idle', batch: type, attempts: 0, error: null, message: null };
          const statusLabel = slotState.status.charAt(0).toUpperCase() + slotState.status.slice(1);
          const showBatchSpinner = slotState.status === 'generating' || slotState.status === 'retrying';
          const placeholderMessage = slotState.error
            ? `${statusLabel}: ${slotState.error}`
            : slotState.message
              ? `${statusLabel}: ${slotState.message}`
              : `${statusLabel}${slotState.status === 'idle' ? ' – awaiting generation' : ''}`;

          return (
            <div key={key} className="image-card">
              <div className="image-card-header">
                <div className="image-card-header-main">
                  <h2>{title}</h2>
                  <div className="dimension-inputs">
                    <input type="number" value={width} onChange={e => handleDimensionChange(key, 'width', e.target.value)} aria-label={`${title} width`} />
                    <span>&times;</span>
                    <input type="number" value={height} onChange={e => handleDimensionChange(key, 'height', e.target.value)} aria-label={`${title} height`} />
                  </div>
                </div>
                {isRemovable && <button className="btn-remove" onClick={() => removeInnerImage(key)} aria-label="Remove image">&times;</button>}
                {history.length > 0 && <span className="version-info">Version {currentIndex + 1} / {history.length}</span>}
              </div>
              <div className={`image-container ${aspectClass}`} style={{aspectRatio: `${width} / ${height}`}}>
                {((showBatchSpinner && isBatchRunning) || regenerating === key) && (
                  <div className="loading-overlay"><div className="spinner"></div></div>
                )}
                {currentImageSrc
                  ? <img src={currentImageSrc} alt={title} />
                  : <span className="placeholder-text">{placeholderMessage}</span>}
              </div>
              <div className={`slot-status slot-status-${slotState.status}`}>
                <span className="slot-status-label">{statusLabel}</span>
                {slotState.message && <span className="slot-status-message"> · {slotState.message}</span>}
                {slotState.status === 'error' && slotState.error && (
                  <span className="slot-status-error"> · {slotState.error}</span>
                )}
              </div>
              <div className="image-actions">
                <button className="btn btn-secondary" onClick={() => setModalState({ key, history, index: currentIndex })} disabled={!currentImageSrc}>View</button>
                <button className="btn btn-secondary" onClick={() => handleDownload(key)} disabled={!currentImageSrc}>Download</button>
                <button className="btn btn-secondary" onClick={() => handleUndo(key)} disabled={!canUndo}>Undo</button>
              </div>
              <div className="regenerate-controls">
                <input
                  type="text"
                  className="regenerate-input"
                  placeholder={currentImageSrc ? "Type changes here..." : "Generates from blog content"}
                  value={modificationPrompts[key] || ''}
                  onChange={(e) => handlePromptChange(e, key)}
                  aria-label={`Modification prompt for ${title}`}
                  disabled={isBatchRunning || !!regenerating || !currentImageSrc}
                />
                <button
                  className="btn btn-secondary"
                  onClick={() => currentImageSrc ? regenerateImage(key) : generateSingleImage(key)}
                  disabled={isBatchRunning || !!regenerating}
                >
                  {currentImageSrc ? 'Regenerate' : 'Generate'}
                </button>
              </div>
            </div>
          )
        })}
      </div>
      <button className="btn btn-primary add-image-btn" onClick={addInnerImage} disabled={isBatchRunning || !!regenerating}>
        + Add Inner Image
      </button>
    </div>
  );
};

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<App />);

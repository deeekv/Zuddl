import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';

type ProviderOption = 'google' | 'hugging-face';

type GeneratedItem =
  | { type: 'image'; contentType: string; src: string }
  | { type: 'json'; contentType: string; data: unknown }
  | { type: 'text'; contentType: string; data: string };

interface ImagePreviewModalProps {
  imageHistory: GeneratedItem[];
  initialIndex: number;
  onClose: () => void;
  onDownload: (item: GeneratedItem, version: number) => void;
}

const ImagePreviewModal: React.FC<ImagePreviewModalProps> = ({ imageHistory, initialIndex, onClose, onDownload }) => {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);

  const handlePrev = () => {
    setCurrentIndex(prev => Math.max(0, prev - 1));
  };

  const handleNext = () => {
    setCurrentIndex(prev => Math.min(imageHistory.length - 1, prev + 1));
  };

  const currentItem = imageHistory[currentIndex];

  const renderPreview = (item: GeneratedItem | undefined) => {
    if (!item) {
      return null;
    }

    if (item.type === 'image') {
      return <img src={item.src} alt={`Image version ${currentIndex + 1}`} />;
    }

    if (item.type === 'json') {
      return <pre className="json-preview" aria-label="JSON preview">{JSON.stringify(item.data, null, 2)}</pre>;
    }

    return <pre className="text-preview" aria-label="Text preview">{item.data}</pre>;
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close-btn" onClick={onClose} aria-label="Close image preview">&times;</button>
        <div className="modal-image-wrapper">
          {renderPreview(currentItem)}
        </div>
        <div className="modal-controls">
          <button className="btn btn-secondary" onClick={handlePrev} disabled={currentIndex === 0}>Previous</button>
          <span>Version {currentIndex + 1} of {imageHistory.length}</span>
          <button className="btn btn-secondary" onClick={handleNext} disabled={currentIndex === imageHistory.length - 1}>Next</button>
          <button
            className="btn btn-primary"
            onClick={() => currentItem && onDownload(currentItem, currentIndex + 1)}
            disabled={!currentItem}
          >
            Download
          </button>
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
}

const SUPPORTED_ASPECT_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16'];

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

const blobToDataURL = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result === 'string') {
        resolve(result);
      } else {
        reject(new Error('Failed to convert blob to data URL.'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read response blob.'));
    reader.readAsDataURL(blob);
  });
};

const parseErrorMessage = (err: unknown): string => {
  if (!err) {
    return 'An unknown error occurred while generating images.';
  }

  if (typeof err === 'string') {
    return err;
  }

  if (typeof err === 'object' && 'error' in (err as Record<string, unknown>)) {
    const message = (err as Record<string, unknown>).error;
    if (typeof message === 'string') {
      return message;
    }
  }

  if (err instanceof Error) {
    try {
      const parsed = JSON.parse(err.message);
      if (typeof parsed?.error === 'string') {
        return parsed.error;
      }
    } catch (_) {
      // ignore JSON parse failures
    }
    return err.message;
  }

  return 'An unknown error occurred while generating images.';
};

interface HuggingFaceRequestPayload {
  inputs: string;
  model?: string;
  parameters?: Record<string, unknown>;
}

const callHuggingFace = async (payload: HuggingFaceRequestPayload): Promise<GeneratedItem> => {
  const requestBody: Record<string, unknown> = { inputs: payload.inputs };
  if (payload.model) {
    requestBody.model = payload.model;
  }
  if (payload.parameters && Object.keys(payload.parameters).length > 0) {
    requestBody.parameters = payload.parameters;
  }

  const response = await fetch('/api/hugging-face', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  const contentType = response.headers.get('content-type') || '';

  if (!response.ok) {
    let message = `Hugging Face request failed with status ${response.status}.`;
    try {
      const data = await response.json();
      if (typeof data?.error === 'string') {
        message = data.error;
      }
    } catch (_) {
      // ignore JSON parse errors and fall back to generic message
    }
    throw new Error(message);
  }

  if (contentType.startsWith('image/')) {
    const blob = await response.blob();
    const dataUrl = await blobToDataURL(blob);
    return { type: 'image', contentType, src: dataUrl };
  }

  if (contentType.includes('application/json')) {
    const data = await response.json();
    return { type: 'json', contentType, data };
  }

  const text = await response.text();
  return { type: 'text', contentType: contentType || 'text/plain', data: text };
};

const downloadGeneratedItem = (key: string, item: GeneratedItem, version: number) => {
  const baseName = `${key}-v${version}`;
  const link = document.createElement('a');

  if (item.type === 'image') {
    link.href = item.src;
    const extension = item.contentType.split('/')[1] || 'png';
    link.download = `${baseName}.${extension}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    return;
  }

  let blob: Blob;
  let extension = 'txt';

  if (item.type === 'json') {
    blob = new Blob([JSON.stringify(item.data, null, 2)], { type: 'application/json' });
    extension = 'json';
  } else {
    blob = new Blob([item.data], { type: item.contentType || 'text/plain' });
  }

  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = `${baseName}.${extension}`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

const App = () => {
  const [selectedProvider, setSelectedProvider] = useState<ProviderOption>('hugging-face');
  const [huggingFaceModel, setHuggingFaceModel] = useState('');
  const [blogContent, setBlogContent] = useState('');
  const [generatedItems, setGeneratedItems] = useState<Record<string, GeneratedItem[]>>({});
  const [currentVersions, setCurrentVersions] = useState<Record<string, number>>({});
  const [modificationPrompts, setModificationPrompts] = useState<Record<string, string>>({
    thumbnail16x9: '',
    thumbnail4x3: '',
    innerImage1: '',
    innerImage2: '',
  });
  const [loading, setLoading] = useState(false);
  const [regenerating, setRegenerating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modalState, setModalState] = useState<{ key: string; history: GeneratedItem[]; index: number } | null>(null);

  const initialImageConfigs: ImageConfig[] = [
    { key: 'thumbnail16x9', title: 'Thumbnail', width: 1280, height: 720, aspectClass: 'aspect-16-9', isRemovable: false },
    { key: 'thumbnail4x3', title: 'Thumbnail', width: 812, height: 608, aspectClass: 'aspect-4-3', isRemovable: false },
    { key: 'innerImage1', title: 'Inner Image', width: 1125, height: 580, aspectClass: 'aspect-16-9', isRemovable: false },
    { key: 'innerImage2', title: 'Inner Image', width: 1125, height: 580, aspectClass: 'aspect-16-9', isRemovable: false },
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

  const ensureHuggingFaceSelected = (action: string) => {
    if (selectedProvider !== 'hugging-face') {
      setError(`Switch the provider to Hugging Face to ${action}.`);
      return false;
    }
    return true;
  };

  const generateInitialImages = async () => {
    if (!blogContent.trim()) {
      setError('Please paste your blog content first.');
      return;
    }

    if (!ensureHuggingFaceSelected('generate images')) {
      return;
    }

    setError(null);
    setLoading(true);
    setGeneratedItems({});
    setCurrentVersions({});

    try {
      const basePrompt = `${STYLE_PROMPT} Based on the following blog content, generate images for a tech blog. Blog Content: "${blogContent}"`;
      const modelOverride = huggingFaceModel.trim() || undefined;

      const results = await Promise.all(imageConfigs.map(async (config) => {
        const aspectRatio = findClosestSupportedRatio(config.width, config.height);
        const prompt = `${basePrompt} Create an image for the ${config.title} slot with dimensions ${config.width}x${config.height} pixels and an aspect ratio of ${aspectRatio}.`;
        const item = await callHuggingFace({
          inputs: prompt,
          model: modelOverride,
          parameters: { aspect_ratio: aspectRatio },
        });
        return { key: config.key, item };
      }));

      const newGeneratedItems: Record<string, GeneratedItem[]> = {};
      const versionMap: Record<string, number> = {};
      results.forEach(({ key, item }) => {
        newGeneratedItems[key] = [item];
        versionMap[key] = 0;
      });

      setGeneratedItems(newGeneratedItems);
      setCurrentVersions(versionMap);
    } catch (err) {
      console.error(err);
      setError(parseErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const regenerateImage = async (imageKey: string) => {
    const modificationPrompt = modificationPrompts[imageKey];
    if (!modificationPrompt.trim()) {
      setError('Please provide a modification instruction for this image.');
      return;
    }

    if (!ensureHuggingFaceSelected('regenerate images')) {
      return;
    }

    setError(null);
    setRegenerating(imageKey);

    const config = imageConfigs.find(c => c.key === imageKey);
    if (!config) {
      setError('Could not find configuration for the image.');
      setRegenerating(null);
      return;
    }
    const aspectRatio = findClosestSupportedRatio(config.width, config.height);

    try {
      const modelOverride = huggingFaceModel.trim() || undefined;
      const prompt = `${STYLE_PROMPT} Regenerate an image for a tech blog based on the original content and a modification request.\nOriginal Blog Content: "${blogContent}"\nModification Request: "${modificationPrompt}"\nThe required aspect ratio is ${aspectRatio}.`;

      const item = await callHuggingFace({
        inputs: prompt,
        model: modelOverride,
        parameters: { aspect_ratio: aspectRatio },
      });

      setGeneratedItems(prev => {
        const history = prev[imageKey] || [];
        const currentIndex = currentVersions[imageKey] ?? history.length - 1;
        const trimmedHistory = currentIndex >= 0 ? history.slice(0, currentIndex + 1) : history;
        return { ...prev, [imageKey]: [...trimmedHistory, item] };
      });
      setCurrentVersions(prev => ({ ...prev, [imageKey]: (prev[imageKey] ?? -1) + 1 }));
    } catch (err) {
      console.error(err);
      setError(parseErrorMessage(err));
    } finally {
      setRegenerating(null);
    }
  };

  const generateSingleImage = async (imageKey: string) => {
    if (!blogContent.trim()) {
      setError('Please paste your blog content first.');
      return;
    }

    if (!ensureHuggingFaceSelected('generate images')) {
      return;
    }

    setError(null);
    setRegenerating(imageKey);

    const config = imageConfigs.find(c => c.key === imageKey);
    if (!config) {
      setError('Could not find configuration for the image.');
      setRegenerating(null);
      return;
    }
    const aspectRatio = findClosestSupportedRatio(config.width, config.height);

    try {
      const modelOverride = huggingFaceModel.trim() || undefined;
      const prompt = `${STYLE_PROMPT} Based on the following blog content, generate an image for a tech blog. Blog Content: "${blogContent}"`;

      const item = await callHuggingFace({
        inputs: `${prompt} The required aspect ratio is ${aspectRatio}.`,
        model: modelOverride,
        parameters: { aspect_ratio: aspectRatio },
      });

      setGeneratedItems(prev => ({ ...prev, [imageKey]: [item] }));
      setCurrentVersions(prev => ({ ...prev, [imageKey]: 0 }));
    } catch (err) {
      console.error(err);
      setError(parseErrorMessage(err));
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
      width: 1125,
      height: 580,
      aspectClass: 'aspect-16-9',
      isRemovable: true,
    };
    setImageConfigs(prev => [...prev, newImage]);
    setModificationPrompts(prev => ({ ...prev, [newKey]: '' }));
  };

  const removeInnerImage = (keyToRemove: string) => {
    setImageConfigs(prev => prev.filter(c => c.key !== keyToRemove));
    setGeneratedItems(prev => {
      const newState = { ...prev };
      delete newState[keyToRemove];
      return newState;
    });
    setCurrentVersions(prev => {
      const newState = { ...prev };
      delete newState[keyToRemove];
      return newState;
    });
    setModificationPrompts(prev => {
      const newState = { ...prev };
      delete newState[keyToRemove];
      return newState;
    });
  };

  const handleUndo = (key: string) => {
    setCurrentVersions(prev => {
      const current = prev[key] ?? 0;
      return { ...prev, [key]: Math.max(0, current - 1) };
    });
  };

  const handleDownload = (key: string) => {
    const history = generatedItems[key];
    const currentIndex = currentVersions[key];
    if (!history || currentIndex === undefined || currentIndex < 0) return;

    const item = history[currentIndex];
    if (!item) return;

    const version = currentIndex + 1;
    downloadGeneratedItem(key, item, version);
  };

  const handleModalDownload = (item: GeneratedItem, version: number) => {
    const key = modalState?.key || 'downloaded-image';
    downloadGeneratedItem(key, item, version);
  };

  const handleProviderChange = (value: ProviderOption) => {
    setSelectedProvider(value);
    setError(null);
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
          <label>Image Provider</label>
          <div className="provider-toggle" role="radiogroup" aria-label="Image provider">
            <label className="provider-option">
              <input
                type="radio"
                name="image-provider"
                value="hugging-face"
                checked={selectedProvider === 'hugging-face'}
                onChange={() => handleProviderChange('hugging-face')}
                disabled={loading || !!regenerating}
              />
              Hugging Face
            </label>
            <label className="provider-option">
              <input
                type="radio"
                name="image-provider"
                value="google"
                checked={selectedProvider === 'google'}
                onChange={() => handleProviderChange('google')}
                disabled={loading || !!regenerating}
              />
              Google
            </label>
          </div>
          {selectedProvider === 'hugging-face' ? (
            <div className="select-container">
              <input
                id="hf-model"
                className="hf-model-input"
                type="text"
                value={huggingFaceModel}
                onChange={(e) => setHuggingFaceModel(e.target.value)}
                placeholder="Optional model override (defaults to stabilityai/sd-turbo)"
                disabled={loading || !!regenerating}
                aria-label="Hugging Face model override"
              />
            </div>
          ) : (
            <p className="provider-help-text">Google image generation is disabled in this environment.</p>
          )}
        </div>
        <textarea
          className="blog-input"
          value={blogContent}
          onChange={(e) => setBlogContent(e.target.value)}
          placeholder="Paste your blog document info here..."
          aria-label="Blog Content Input"
        />
        <button className="btn btn-primary" onClick={generateInitialImages} disabled={loading}>
          {loading ? <><div className="spinner"></div><span>Generating...</span></> : 'Generate Thumbnails'}
        </button>
      </div>
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="image-grid">
        {imageConfigs.map(({ key, title, width, height, aspectClass, isRemovable }) => {
          const history = generatedItems[key] || [];
          const currentIndex = currentVersions[key] ?? (history.length > 0 ? history.length - 1 : -1);
          const hasEntry = history.length > 0 && currentIndex >= 0;
          const currentItem = hasEntry ? history[currentIndex] : undefined;
          const canUndo = currentIndex > 0;

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
                {hasEntry && <span className="version-info">Version {currentIndex + 1} / {history.length}</span>}
              </div>
              <div className={`image-container ${aspectClass}`} style={{ aspectRatio: `${width} / ${height}` }}>
                {(loading || regenerating === key) && (
                  <div className="loading-overlay"><div className="spinner"></div></div>
                )}
                {currentItem ? (
                  currentItem.type === 'image' ? (
                    <img src={currentItem.src} alt={title} />
                  ) : currentItem.type === 'json' ? (
                    <pre className="json-preview">{JSON.stringify(currentItem.data, null, 2)}</pre>
                  ) : (
                    <pre className="text-preview">{currentItem.data}</pre>
                  )
                ) : (!loading && <span className="placeholder-text">Image will appear here</span>)}
              </div>
              <div className="image-actions">
                <button
                  className="btn btn-secondary"
                  onClick={() => hasEntry && setModalState({ key, history, index: currentIndex })}
                  disabled={!hasEntry}
                >
                  View
                </button>
                <button className="btn btn-secondary" onClick={() => handleDownload(key)} disabled={!hasEntry}>Download</button>
                <button className="btn btn-secondary" onClick={() => handleUndo(key)} disabled={!canUndo}>Undo</button>
              </div>
              <div className="regenerate-controls">
                <input
                  type="text"
                  className="regenerate-input"
                  placeholder={hasEntry ? 'Type changes here...' : 'Generates from blog content'}
                  value={modificationPrompts[key] || ''}
                  onChange={(e) => handlePromptChange(e, key)}
                  aria-label={`Modification prompt for ${title}`}
                  disabled={loading || !!regenerating || !hasEntry}
                />
                <button
                  className="btn btn-secondary"
                  onClick={() => hasEntry ? regenerateImage(key) : generateSingleImage(key)}
                  disabled={loading || !!regenerating}
                >
                  {hasEntry ? 'Regenerate' : 'Generate'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <button className="btn btn-primary add-image-btn" onClick={addInnerImage} disabled={loading || !!regenerating}>
        + Add Inner Image
      </button>
    </div>
  );
};

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<App />);

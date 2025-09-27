
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI } from '@google/genai';

type GenerationModel =
  | 'gemini-1.5-flash'
  | 'gemini-1.5-flash-latest'
  | 'gemini-1.5-pro'
  | 'gemini-1.5-pro-latest'
  | 'imagen-4.0-generate-001';

interface ModelOption {
  value: GenerationModel;
  label: string;
  paid?: boolean;
}

const CORE_MODEL_OPTIONS: ModelOption[] = [
  { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
  { value: 'gemini-1.5-flash-latest', label: 'Gemini 1.5 Flash (Latest)' },
  { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
  { value: 'gemini-1.5-pro-latest', label: 'Gemini 1.5 Pro (Latest)' },
];

const OPTIONAL_MODEL_OPTIONS: ModelOption[] = [
  { value: 'imagen-4.0-generate-001', label: 'Imagen 4.0', paid: true },
];

const ALL_MODEL_OPTIONS: ModelOption[] = [...CORE_MODEL_OPTIONS, ...OPTIONAL_MODEL_OPTIONS];

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
}

const SUPPORTED_ASPECT_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16"];

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
    thumbnail4x3: '',
    innerImage1: '',
    innerImage2: '',
  });
  const [loading, setLoading] = useState(false);
  const [regenerating, setRegenerating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<GenerationModel>(ALL_MODEL_OPTIONS[0].value);
  const [modalState, setModalState] = useState<{ key: string; history: string[]; index: number } | null>(null);
  
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

  const generateInitialImages = async () => {
    if (!blogContent.trim()) {
      setError('Please paste your blog content first.');
      return;
    }
    setError(null);
    setLoading(true);
    setImages({});
    setCurrentVersions({});

    try {
        const ai = getGenAIClient();
        const basePrompt = `${STYLE_PROMPT} Based on the following blog content, generate images for a tech blog. Blog Content: "${blogContent}"`;
        
        const groupedByAspectRatio = imageConfigs.reduce((acc, config) => {
            const ratio = findClosestSupportedRatio(config.width, config.height);
            if (!acc[ratio]) acc[ratio] = [];
            acc[ratio].push(config);
            return acc;
        }, {} as Record<string, ImageConfig[]>);

        const allGeneratedImages: { key: string, src: string }[] = [];

        for (const ratio in groupedByAspectRatio) {
            const configs = groupedByAspectRatio[ratio];
            const prompt = `${basePrompt} Generate ${configs.length} different image(s).`;
            const response = await ai.models.generateImages({
                model: selectedModel,
                prompt,
                config: { numberOfImages: configs.length, outputMimeType: 'image/png', aspectRatio: ratio },
            });
            response.generatedImages.forEach((img, index) => {
                allGeneratedImages.push({
                    key: configs[index].key,
                    src: `data:image/png;base64,${img.image.imageBytes}`,
                });
            });
        }
        
        const newImages: Record<string, string[]> = {};
        allGeneratedImages.forEach(({ key, src }) => newImages[key] = [src]);
        setImages(newImages);

        const initialVersions: Record<string, number> = {};
        Object.keys(newImages).forEach(key => initialVersions[key] = 0);
        setCurrentVersions(initialVersions);

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

    try {
        const ai = getGenAIClient();
        let newImageSrc: string | null = null;
        
        const prompt = `${STYLE_PROMPT} Regenerate an image for a tech blog based on the original content and a modification request.
        Original Blog Content: "${blogContent}"
        Modification Request: "${modificationPrompt}"
        The required aspect ratio is ${aspectRatio}.`;

        const response = await ai.models.generateImages({
            model: selectedModel,
            prompt,
            config: { numberOfImages: 1, outputMimeType: 'image/png', aspectRatio },
        });
        newImageSrc = `data:image/png;base64,${response.generatedImages[0].image.imageBytes}`;

        if (newImageSrc) {
            setImages(prev => {
                const history = prev[imageKey] || [];
                // Truncate history if we have undone changes
                const newHistory = history.slice(0, (currentVersions[imageKey] ?? 0) + 1);
                return { ...prev, [imageKey]: [...newHistory, newImageSrc as string] };
            });
            setCurrentVersions(prev => ({...prev, [imageKey]: (prev[imageKey] ?? -1) + 1}));
        }

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
    setError(null);
    setRegenerating(imageKey);

    const config = imageConfigs.find(c => c.key === imageKey);
    if (!config) {
        setError("Could not find configuration for the image.");
        setRegenerating(null);
        return;
    }
    const aspectRatio = findClosestSupportedRatio(config.width, config.height);

    try {
        const ai = getGenAIClient();
        const prompt = `${STYLE_PROMPT} Based on the following blog content, generate an image for a tech blog. Blog Content: "${blogContent}"`;
        
        const response = await ai.models.generateImages({
            model: selectedModel,
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
        } else {
            throw new Error("Image generation failed to return an image.");
        }

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
    setModificationPrompts(prev => ({...prev, [newKey]: ''}));
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
            <label htmlFor="model-selector">Regeneration Model</label>
            <div className="select-container">
              <select
                  id="model-selector"
                  className="model-selector"
                  value={selectedModel}
                  onChange={e => setSelectedModel(e.target.value as GenerationModel)}
                  disabled={loading || !!regenerating}
              >
                  {CORE_MODEL_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                  {OPTIONAL_MODEL_OPTIONS.length > 0 && (
                    <optgroup label="Optional (Paid)">
                      {OPTIONAL_MODEL_OPTIONS.map(option => (
                        <option key={option.value} value={option.value}>
                          {option.label}{option.paid ? ' (Paid)' : ''}
                        </option>
                      ))}
                    </optgroup>
                  )}
              </select>
            </div>
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
          const history = images[key] || [];
          const currentIndex = currentVersions[key] ?? -1;
          const currentImageSrc = history[currentIndex];
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
                {history.length > 0 && <span className="version-info">Version {currentIndex + 1} / {history.length}</span>}
              </div>
              <div className={`image-container ${aspectClass}`} style={{aspectRatio: `${width} / ${height}`}}>
                {(loading || regenerating === key) && (
                  <div className="loading-overlay"><div className="spinner"></div></div>
                )}
                {currentImageSrc ? <img src={currentImageSrc} alt={title} /> : (!loading && <span className="placeholder-text">Image will appear here</span>)}
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
                  disabled={loading || !!regenerating || !currentImageSrc}
                />
                <button
                  className="btn btn-secondary"
                  onClick={() => currentImageSrc ? regenerateImage(key) : generateSingleImage(key)}
                  disabled={loading || !!regenerating}
                >
                  {currentImageSrc ? 'Regenerate' : 'Generate'}
                </button>
              </div>
            </div>
          )
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

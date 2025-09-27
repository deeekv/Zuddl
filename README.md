<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/drive/1x2YAwapicOdwQmvWGxOffnml_H0jnf68

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `VITE_GEMINI_API_KEY` in [.env.local](.env.local) (or your shell) to your Gemini API key. The `VITE_` prefix is required so Vite exposes the value to the client bundle.
3. Set `HUGGING_FACE_TOKEN` for the Hugging Face proxy (the handler also accepts the legacy `HUGGING_FACE_API_TOKEN`).
4. Run the app:
   `npm run dev`

## Deploying to Vercel

- Add `VITE_GEMINI_API_KEY` to your project's **Build & Runtime Environment Variables** in the Vercel dashboard so the key is available when Vite builds the production bundle.
- Never commit your API key to the repository. Use the environment variable configuration instead.

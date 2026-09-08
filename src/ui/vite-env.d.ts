declare module "*.css";

interface Window {
  openai?: import('./approval-bridge.js').ChatGptApprovalBridge & {
    toolOutput?: unknown;
    toolResponseMetadata?: unknown;
  };
}

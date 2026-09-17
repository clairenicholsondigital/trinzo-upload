import { broadcastResponseToMainFrame } from '@azure/msal-browser/redirect-bridge';

broadcastResponseToMainFrame().catch(() => {
  document.body.textContent = 'Microsoft sign-in could not be completed. Close this window and try again.';
});

(function () {
  'use strict';

  var directLine;
  var status = document.getElementById('agentStatus');
  var statusText = document.getElementById('agentStatusText');
  var errorText = document.getElementById('agentError');
  var webchat = document.getElementById('webchat');
  var newConversation = document.getElementById('newConversation');

  function setStatus(state, message) {
    status.dataset.state = state;
    statusText.textContent = message;
  }

  function showError(message) {
    errorText.textContent = message;
    errorText.hidden = false;
    setStatus('error', 'Agent unavailable');
  }

  function createStore() {
    return window.WebChat.createStore({}, function (_ref) {
      var dispatch = _ref.dispatch;
      return function (next) {
        return function (action) {
          if (action.type === 'DIRECT_LINE/CONNECT_FULFILLED') {
            setStatus('connected', 'Agent connected');
            dispatch({
              type: 'DIRECT_LINE/POST_ACTIVITY',
              meta: { method: 'keyboard' },
              payload: {
                activity: {
                  channelData: { postBack: true },
                  name: 'startConversation',
                  type: 'event'
                }
              }
            });
          } else if (action.type === 'DIRECT_LINE/CONNECT_REJECTED') {
            showError('The connection to the agent could not be established. Please try a new conversation.');
          }
          return next(action);
        };
      };
    });
  }

  async function connect() {
    newConversation.disabled = true;
    errorText.hidden = true;
    errorText.textContent = '';
    setStatus('connecting', 'Connecting to the agent…');

    try {
      if (!window.WebChat) throw new Error('Microsoft Web Chat did not load.');
      if (directLine && typeof directLine.end === 'function') directLine.end();
      webchat.replaceChildren();

      var response = await fetch('/api/meeting-minutes-agent/token', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      var payload = await response.json().catch(function () { return {}; });
      if (!response.ok || !payload.token) {
        throw new Error(payload.error || 'The agent token could not be issued.');
      }

      directLine = window.WebChat.createDirectLine({
        domain: payload.domain,
        token: payload.token
      });
      window.WebChat.renderWebChat({
        directLine: directLine,
        locale: 'en-GB',
        store: createStore(),
        styleOptions: {
          accent: '#2c7a90',
          backgroundColor: '#f4f7f9',
          bubbleBackground: '#ffffff',
          bubbleBorderColor: '#d9e1e8',
          bubbleFromUserBackground: '#dcebf0',
          bubbleFromUserBorderColor: '#c3dde5',
          bubbleFromUserTextColor: '#17222c',
          bubbleTextColor: '#17222c',
          hideUploadButton: false,
          primaryFont: 'Roboto, Segoe UI, Arial, sans-serif',
          sendBoxBackground: '#ffffff'
        }
      }, webchat);

      var focusTarget = webchat.querySelector('[tabindex="0"]');
      if (focusTarget) focusTarget.focus();
    } catch (error) {
      showError(error && error.message ? error.message : 'The agent is temporarily unavailable.');
    } finally {
      newConversation.disabled = false;
    }
  }

  newConversation.addEventListener('click', connect);
  connect();
})();

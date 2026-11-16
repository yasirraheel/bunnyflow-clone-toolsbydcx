const title = document.querySelector('#status-title');
const copy = document.querySelector('#status-copy');
const credits = document.querySelector('#credits');
const check = async () => {
  const tabs = await chrome.tabs.query({active: true, currentWindow: true});
  const tab = tabs[0];
  const isFlow = Boolean(tab?.url && /https:\/\/(flow\.google\.com|labs\.google)\//.test(tab.url));
  title.textContent = isFlow ? 'Flow page detected' : 'Open Flow to connect';
  copy.textContent = isFlow ? 'Tools By DCX UI bridge is available.' : 'This popup is ready for a Flow tab.';
  const saved = await chrome.storage.local.get(['toolsByDcxDemoCredits']);
  credits.textContent = Number(saved.toolsByDcxDemoCredits ?? 24040).toLocaleString();
};
document.querySelector('#check').addEventListener('click', check);
document.querySelector('#open-flow').addEventListener('click', () => chrome.tabs.create({url: 'https://flow.google.com/'}));
check();

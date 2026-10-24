Promise.all([chrome.storage.session.get("status"), chrome.storage.local.get(["sessions", "tabOwners"])]).then(([{ status }, { sessions = {}, tabOwners = {} }]) => {
  document.getElementById("status").textContent = status ?? "Starting…";
  const agents = Object.keys(sessions).length;
  const tabs = Object.keys(tabOwners).length;
  document.getElementById("sessions").textContent = `${agents} agent session(s), ${tabs} agent tab(s).`;
});

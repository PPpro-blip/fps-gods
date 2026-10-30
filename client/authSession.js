// The server, not cached browser state, decides whether this player is signed in.
export async function restoreAuthSession(ui, network, guestProfileId) {
  ui.setAuthRestoring(true);
  try {
    const res = await network.apiRequest('/api/auth/me');
    if (res?.status) ui.setAuthStatus(res.status);
    if (res?.authenticated && res.account) {
      ui.setProfile(res.account);
      ui.setWallet(res.wallet, { loading: false, error: '' });
    } else {
      ui.resetToGuestProfile(guestProfileId);
      if (network.connected) network.requestProfile(guestProfileId, ui.playerName);
    }
  } catch {
    ui.resetToGuestProfile(guestProfileId);
  } finally {
    ui.setAuthRestoring(false);
  }
}

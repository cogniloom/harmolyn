// Reusable UI flows for two-client E2E scenarios.
import { until } from './harness.mjs';

/** Register a fresh account and land on the (empty) home screen, tour skipped. */
export async function register(c, name, password = 'correct horse battery') {
  const { page } = c;
  await until(async () => (await page.locator('#root').innerText()).length > 50, { what: `${c.name} boot` });
  // Fresh installs may show the auth welcome screen ("Create an account"),
  // while guest-first startup exposes the same flow from its persistent
  // "Create account" bar. Exercise whichever entry point the user sees.
  await page.getByRole('button', { name: /^Create (?:an )?account$/i }).first().click();
  await page.getByPlaceholder('e.g. Sam').fill(name);
  await page.getByPlaceholder('At least 10 characters').fill(password);
  await page.getByPlaceholder('Re-enter your password').fill(password);
  await page.getByRole('checkbox', { name: /Confirm age/ }).check();
  await page.getByRole('button', { name: 'Create account', exact: true }).first().click();
  // Key-reveal step: capture the public key, then continue without backup.
  const keyEl = page.locator('p', { hasText: /^12D3Koo/ }).first();
  await keyEl.waitFor({ timeout: 20000 });
  const peerId = (await keyEl.innerText()).trim();
  await page.getByRole('button', { name: 'Continue without a backup' }).click();
  await page.getByRole('button', { name: 'Continue anyway' }).click();
  await page.getByRole('button', { name: 'SKIP' }).click();
  return peerId;
}

/** Create a server via the welcome tile or the rail "+" button. */
export async function createServer(c, serverName) {
  const { page } = c;
  const tile = page.getByRole('button', { name: /^Create a server/ });
  if (await tile.count()) {
    await tile.click();
  } else {
    await page.getByRole('button', { name: 'Create Server' }).click();
  }
  await page.getByRole('textbox', { name: 'Node Name' }).fill(serverName);
  await page.getByRole('button', { name: 'Initiate Matrix' }).click();
  // Server appears in the rail and #general is selected.
  await page.getByRole('button', { name: 'general' }).waitFor({ timeout: 20000 });
}

/** Copy the current server's invite link from the server menu; returns the invite string. */
export async function copyInvite(c) {
  const { page } = c;
  await page.getByRole('button', { name: 'Server menu' }).click();
  await page.getByRole('menuitem', { name: 'Copy Invite Link' })
    .or(page.getByText('Copy Invite Link')).first().click();
  return until(async () => {
    const text = await page.evaluate(() => navigator.clipboard.readText());
    return text && text.includes('invite') ? text : null;
  }, { what: 'invite on clipboard' });
}

/** Join a server from the welcome tile / rail using an invite string. */
export async function joinByInvite(c, invite, expectedServerName) {
  const { page } = c;
  const tile = page.getByRole('button', { name: /^Join with an invite/ });
  if (await tile.count()) {
    await tile.click();
  } else {
    await page.getByRole('button', { name: 'Create Server' }).click();
    await page.getByRole('button', { name: 'HAVE AN INVITE ALREADY?' }).click();
  }
  // Scope to the modal's labelled field. A user can open this flow while a
  // channel/DM composer remains mounted behind the dialog; selecting the last
  // textbox silently filled that background composer instead of the invite.
  const box = page.getByRole('textbox', { name: 'INVITE LINK' });
  await box.fill(invite);
  await page.getByRole('button', { name: 'Join Server' }).click();
  await page.getByRole('button', { name: `Server: ${expectedServerName}` }).waitFor({ timeout: 30000 });
}

/** Send a chat message through the composer. */
export async function sendMessage(c, text) {
  const { page } = c;
  const box = page.getByRole('textbox', { name: 'Message Input' });
  await box.fill(text);
  await page.getByRole('button', { name: 'Send Message' }).click();
}

/** Wait until a message containing `text` is visible in the message list. */
export async function waitForMessage(c, text, timeout = 30000) {
  await c.page.getByText(text, { exact: false }).first().waitFor({ timeout });
}

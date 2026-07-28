// In-app legal documents for a public release. These are OPERATOR-CUSTOMIZABLE
// TEMPLATES: bracketed placeholders ([OPERATOR], [JURISDICTION], [CONTACT]) must be
// completed by whoever deploys this build, and the effective date set. They are
// written to fit an end-to-end-encrypted, peer-to-peer client (the operator cannot
// read message contents), which materially changes the usual boilerplate.
//
// This is not legal advice. Operators should have counsel review before launch.

export interface LegalSection {
  heading: string;
  body: string[];
}

export interface LegalDoc {
  id: 'terms' | 'privacy' | 'guidelines';
  title: string;
  subtitle: string;
  updated: string;
  sections: LegalSection[];
}

const PLACEHOLDER_NOTE =
  'This document is a template shipped with the open-source Harmolyn client. The operator of this instance ([OPERATOR]) must review, complete the bracketed fields, and set the effective date before public launch.';

export const AGE_REQUIREMENT_TEXT =
  'You must be at least 16 years old (or the minimum age of digital consent in your country, if higher) to create an account.';

export const LEGAL_DOCS: LegalDoc[] = [
  {
    id: 'terms',
    title: 'Terms of Service',
    subtitle: 'The agreement for using this Harmolyn instance',
    updated: '[EFFECTIVE DATE]',
    sections: [
      { heading: 'About these terms', body: [PLACEHOLDER_NOTE, 'By creating an account or using Harmolyn, you agree to these Terms and to the Community Guidelines. If you do not agree, do not use the service.'] },
      { heading: 'Who may use Harmolyn', body: [AGE_REQUIREMENT_TEXT, 'You are responsible for keeping your account (a cryptographic key held on your device) and its backup safe. There is no password reset — if you lose your password and your recovery options, your account cannot be restored.'] },
      { heading: 'What Harmolyn is', body: ['Harmolyn is an end-user client for the xorein peer-to-peer network. Your direct messages and private channels are end-to-end encrypted: the operator and the support node ([OPERATOR]) carry only ciphertext and cannot read their contents.', 'The support node provides bootstrap/relay connectivity and stores encrypted files and encrypted account backups. It is a best-effort service provided “as is”, without warranty, and may be unavailable at times.'] },
      { heading: 'Your content and conduct', body: ['You are solely responsible for the content you send and the communities you run. You must not use Harmolyn to break the law or to violate the Community Guidelines.', 'Because the operator cannot read encrypted content, moderation of private spaces is performed by their participants and owners, and by you (block, mute, leave, report). Server owners are responsible for moderating the servers they create.'] },
      { heading: 'Reporting and enforcement', body: ['You can report abuse from within the app. Reports about a server are delivered to that server’s owner; reports that concern the operator’s services or illegal content may be sent to [CONTACT]. The operator may restrict access to its support services (relay, blob storage) for accounts that abuse them, but cannot remove content it cannot read from other peers.'] },
      { heading: 'Intellectual property & DMCA', body: ['Harmolyn is free software under AGPL-3.0-or-later. Respect others’ rights in the content you share. To report claimed copyright infringement in content hosted by the operator’s support node, contact [DMCA CONTACT] with the information required by applicable law.'] },
      { heading: 'Disclaimers & liability', body: ['The service is provided “as is” and “as available”. To the maximum extent permitted by law, the operator disclaims all warranties and is not liable for indirect or consequential damages arising from your use of the service.'] },
      { heading: 'Changes & governing law', body: ['These Terms may be updated; continued use after an update constitutes acceptance. These Terms are governed by the laws of [JURISDICTION], without regard to conflict-of-laws rules.', 'Questions: [CONTACT].'] },
    ],
  },
  {
    id: 'privacy',
    title: 'Privacy Policy',
    subtitle: 'What is (and isn’t) collected, and why',
    updated: '[EFFECTIVE DATE]',
    sections: [
      { heading: 'Summary', body: [PLACEHOLDER_NOTE, 'Harmolyn is privacy-first. Your identity keys never leave your device unencrypted, your message contents are end-to-end encrypted, and the app fetches remote link/media previews only when you allow it.'] },
      { heading: 'What stays on your device', body: ['Your identity (a cryptographic key pair), your message history, drafts, and app settings are stored locally and encrypted at rest. Registered accounts are protected with a password (Argon2id); guest sessions are ephemeral.'] },
      { heading: 'What the support node can see', body: ['To deliver messages between peers, the relay observes connection metadata — which peers connect and when — but not message contents, which are end-to-end encrypted. Offline messages are held as opaque ciphertext under blinded, rotating tokens that are not linkable to your identity.', 'Files and avatars you upload are encrypted on your device before upload; the node stores only ciphertext and cannot decrypt them. Encrypted account backups you choose to store are likewise opaque to the node.'] },
      { heading: 'What you control', body: ['Remote media/link previews are OFF by default and load nothing until you opt in. Presence (online status, typing) is shared with your contacts and can be limited in Privacy settings. You can export or delete your local data at any time.'] },
      { heading: 'No selling, no ads, no content scanning', body: ['The operator does not sell your data, does not serve advertising, and cannot scan the contents of your encrypted conversations.'] },
      { heading: 'Your rights', body: ['Depending on your jurisdiction (e.g. GDPR/EU, CCPA/California) you may have rights to access, correct, or delete personal data the operator holds. Because most data is on your device or end-to-end encrypted, the operator holds little about you; to exercise rights over what it does hold (e.g. relay logs, stored ciphertext), contact [CONTACT].'] },
      { heading: 'Children', body: [AGE_REQUIREMENT_TEXT, 'The service is not directed to children under this age.'] },
    ],
  },
  {
    id: 'guidelines',
    title: 'Community Guidelines',
    subtitle: 'Acceptable use — the rules everyone agrees to',
    updated: '[EFFECTIVE DATE]',
    sections: [
      { heading: 'Be a decent human', body: ['Harmolyn is for people all over the world to talk safely. Treat others with respect. Harassment, hate speech, threats, and targeting individuals are not allowed.'] },
      { heading: 'Do not use Harmolyn to harm others', body: ['No content that sexualizes minors, incites violence, promotes terrorism, or facilitates serious crime. No sharing of others’ private information without consent (doxxing). No malware, phishing, or fraud.'] },
      { heading: 'Respect the network', body: ['Do not spam, flood, or attempt to disrupt the network or its support services. Do not attempt to de-anonymize other users or defeat the encryption that protects everyone.'] },
      { heading: 'Server owners set the tone', body: ['If you run a server, you are its moderator: set rules, use roles and automod, remove members who break them. Members can always block, mute, leave, and report.'] },
      { heading: 'Enforcement', body: ['Breaking these guidelines can get you removed from a server by its owner, blocked by other users, or — for abuse of the operator’s services or illegal content — restricted from the support node. Report violations from the app; serious or illegal matters go to [CONTACT].'] },
    ],
  },
];

export function getLegalDoc(id: LegalDoc['id']): LegalDoc | undefined {
  return LEGAL_DOCS.find((d) => d.id === id);
}

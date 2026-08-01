// In-app legal and network-governance notices for the decentralized Harmolyn
// client. They intentionally do not imply that Cogniloom operates a central
// Harmolyn service. This is not legal advice; people who operate a Space or a
// public Xorein Node remain responsible for the laws that apply to them.

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

const EFFECTIVE_DATE = '1 August 2026';

export const AGE_REQUIREMENT_TEXT =
  'You may use Harmolyn only if you are legally able to do so where you live and meet any age requirement imposed by applicable law or by the Space you join.';

export const LEGAL_DOCS: LegalDoc[] = [
  {
    id: 'terms',
    title: 'Terms of Use',
    subtitle: 'Software, network, and Space responsibilities',
    updated: EFFECTIVE_DATE,
    sections: [
      {
        heading: 'What Harmolyn is',
        body: [
          'Harmolyn is free, decentralized communication software published by the Cogniloom project and its contributors under the GNU Affero General Public License, version 3 or later (AGPL-3.0-or-later). The license — not this notice — grants your rights to use, study, modify, and redistribute the software.',
          'There is no central Harmolyn service or network-wide operator. Harmolyn clients communicate directly and may use independently operated Xorein Nodes for discovery, relay, TURN, bandwidth, and encrypted storage. A node assists the network; it does not own the network or the Spaces that use it.',
        ],
      },
      {
        heading: 'Spaces and authority',
        body: [
          'A community created inside Harmolyn is called a Space. The person who creates a Space is its Space Owner and its ultimate authority. The Space Owner chooses its rules, membership, moderators, retention policy, and lawful purpose, and is solely responsible for administering that Space and the content made available through it.',
          'A Space Owner may delegate permissions, but that delegation does not transfer responsibility to Harmolyn contributors or to unrelated Xorein Node Operators. Members decide whether to join and may block, mute, report, or leave.',
        ],
      },
      {
        heading: 'Your responsibilities',
        body: [
          AGE_REQUIREMENT_TEXT,
          'You are responsible for your conduct, the content you publish, compliance with applicable law, and safeguarding your identity keys, password, and recovery material. No contributor, Space Owner, or Node Operator can recover an identity unless you previously configured a supported encrypted recovery method.',
          'Do not use Harmolyn, a Space, or a Xorein Node to harm others, distribute unlawful material, infringe rights, or interfere with systems you do not own or have permission to test.',
        ],
      },
      {
        heading: 'Independent Xorein Nodes',
        body: [
          'Every Xorein Node is independently operated. Its operator controls only that node and may publish its own access, storage, retention, abuse, and privacy terms. A Node Operator may limit or refuse use of its own resources, but cannot speak for the network, govern unrelated Spaces, decrypt end-to-end-encrypted content, or erase replicas held elsewhere.',
          'Nodes and peers are untrusted transport and storage providers. Cryptographic signatures and content hashes are used to detect altered data, but availability, delivery, discovery, and preservation are best-effort and are never guaranteed.',
        ],
      },
      {
        heading: 'Reports and copyright notices',
        body: [
          'Send a content or conduct report to the relevant Space Owner, who is the authority for that Space. Send a report about abuse of a particular Xorein Node to that Node Operator. The Cogniloom project has no ability to moderate an independently operated Space or remove data from independent devices.',
          'Copyright complaints must go to the person or operator who controls the location at which the material is published or stored. For material published in the official Cogniloom source repositories, use the repository’s GitHub contact or issue facilities. Cogniloom does not designate itself as the agent for independently operated Spaces or Nodes.',
        ],
      },
      {
        heading: 'No warranty or support obligation',
        body: [
          'The software and protocol are provided “as is” and “as available,” without warranty, service-level commitment, guaranteed compatibility, guaranteed delivery, or contractual obligation to provide maintenance or support. To the maximum extent permitted by applicable law, contributors and independent operators disclaim liability for loss or damage arising from use or inability to use the software or network.',
          'Nothing in this notice excludes a right or liability that applicable law does not permit a party to exclude. An independent Space Owner or Node Operator may assume additional obligations through separate terms; those obligations bind only that operator.',
        ],
      },
      {
        heading: 'Software changes and applicable law',
        body: [
          'The AGPL-3.0-or-later license governs the Harmolyn and Xorein software. A Space Owner’s published rules and applicable law govern activity in that Space. A Node Operator’s terms and applicable law govern use of that node. Because these parties are independent and distributed worldwide, there is no single Harmolyn network jurisdiction or central set of operator terms.',
          'Protocol and client updates may change functionality or security requirements. Signed compatibility metadata is used to reject unsafe downgrades; very old software may eventually be unable to communicate with a newer security floor.',
        ],
      },
    ],
  },
  {
    id: 'privacy',
    title: 'Privacy Notice',
    subtitle: 'Where data goes in a decentralized network',
    updated: EFFECTIVE_DATE,
    sections: [
      {
        heading: 'No central data controller',
        body: [
          'Harmolyn is software, not a centrally hosted account service. Cogniloom contributors do not receive your Harmolyn data merely because you install the client. A Space Owner, Xorein Node Operator, peer, package store, or repository host may independently process data when you choose to interact with it and is responsible for its own legal obligations.',
        ],
      },
      {
        heading: 'What stays on your device',
        body: [
          'Your identity keys, message history, drafts, contacts, and settings are primarily stored on your device. Registered identities are encrypted at rest with a key derived from your password. Configured recovery copies are encrypted before they are distributed; providers do not receive your password or plaintext key.',
          'Deleting local data removes that device’s copy. It cannot guarantee deletion of messages or encrypted replicas already held by recipients, peers, backups, or independently operated Nodes.',
        ],
      },
      {
        heading: 'What other participants can observe',
        body: [
          'End-to-end encryption protects supported message and file contents in transit and storage. It does not hide everything: peers and Nodes involved in a connection may observe network addresses, timing, traffic volume, routing identifiers, public profile data, Space membership needed by the protocol, and other operational metadata.',
          'Relayed offline deliveries, files, recovery packets, and replicated Space state are encrypted before distribution where the protocol marks them private. Cryptographic integrity metadata may remain visible. No anonymity guarantee is made.',
        ],
      },
      {
        heading: 'Your controls',
        body: [
          'Remote media and link previews are disabled by default. Presence, typing indicators, discovery, recovery providers, and storage choices can be limited in the app. You can export local data, leave a Space, block peers, remove configured Nodes, and delete your local profile.',
        ],
      },
      {
        heading: 'Independent operators and your rights',
        body: [
          'Ask the relevant Space Owner or Node Operator about logs, retention, lawful requests, deletion, or privacy rights for data that operator controls. Ask GitHub or another distributor about data collected when you use its website or download service. The Cogniloom project cannot access, correct, or erase data it does not possess.',
          'Official Harmolyn software contains no advertising system and no mechanism for contributors to sell message contents. Modified third-party builds can behave differently; use only releases whose signature and source you trust.',
        ],
      },
      {
        heading: 'Age and lawful use',
        body: [
          AGE_REQUIREMENT_TEXT,
          'Space Owners and Node Operators are responsible for any notices, consent mechanisms, or restrictions required for the communities and infrastructure they operate.',
        ],
      },
    ],
  },
  {
    id: 'guidelines',
    title: 'Community Guidelines',
    subtitle: 'A baseline that each Space Owner can strengthen',
    updated: EFFECTIVE_DATE,
    sections: [
      {
        heading: 'The Space Owner sets the rules',
        body: [
          'Every Space is independent. Its Space Owner is the ultimate authority for membership and moderation and may publish stricter rules than this baseline. Before participating, understand the rules and laws that apply to that Space.',
        ],
      },
      {
        heading: 'Do not harm people',
        body: [
          'Do not harass, threaten, exploit, defraud, stalk, or expose another person’s private information without consent. Never sexualize or exploit minors, incite violence, facilitate serious crime, distribute malware, phish credentials, or use the network to attack systems.',
        ],
      },
      {
        heading: 'Respect rights and consent',
        body: [
          'Publish only content you have the right to share. Respect privacy, intellectual-property rights, consent, and the rules of the Space in which you participate.',
        ],
      },
      {
        heading: 'Respect the network',
        body: [
          'Do not spam, flood, scrape private data, evade legitimate resource limits, deliberately corrupt replicas, abuse relay or TURN capacity, impersonate peers, attempt unsafe protocol downgrades, or try to defeat security controls protecting other users.',
        ],
      },
      {
        heading: 'Enforcement is decentralized',
        body: [
          'A Space Owner can remove members or content from the Space state that owner controls. Participants can block, mute, report, and leave. A Xorein Node Operator can restrict access to that node’s resources. These actions do not create network-wide authority and cannot guarantee removal from devices or replicas outside the actor’s control.',
          'Report Space matters to the Space Owner, node-resource abuse to the relevant Node Operator, and immediate danger or suspected crime to the appropriate local authority. Report vulnerabilities in official code privately through the GitHub Security Advisory page identified in AUDIT.md.',
        ],
      },
    ],
  },
];

export function getLegalDoc(id: LegalDoc['id']): LegalDoc | undefined {
  return LEGAL_DOCS.find((document) => document.id === id);
}

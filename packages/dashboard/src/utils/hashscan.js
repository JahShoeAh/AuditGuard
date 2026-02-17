const BASE = 'https://hashscan.io/testnet';

export const hashscan = {
  networkUrl: BASE,
  transaction:   (hash)              => `${BASE}/transaction/${hash}`,
  account:       (id)                => `${BASE}/account/${id}`,
  token:         (id)                => `${BASE}/token/${id}`,
  topic:         (id)                => `${BASE}/topic/${id}`,
  topicMessage:  (topicId, seqNum)   => `${BASE}/topic/${topicId}/message/${seqNum}`,
  contract:      (id)                => `${BASE}/contract/${id}`,
};

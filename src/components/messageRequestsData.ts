export interface MessageRequest {
  id: string;
  userId: string;
  preview: string;
  timestamp: string;
}

// No fabricated message requests — real requests arrive via props from the
// runtime. An empty default ensures the UI shows its empty state until then.
export const DEFAULT_MESSAGE_REQUESTS: MessageRequest[] = [];

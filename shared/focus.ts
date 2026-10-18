export type Focus = {
  taskId: string;
  remaining: number;
  endsAt: number | null;
};
export type FocusState = { focus: Focus | null; version: number };

import { z } from "zod";
import { dateKey, type Task } from "../shared/tasks";
export const TagsSchema = z
  .array(
    z.object({
      name: z.string().trim().min(1).max(24),
      color: z.enum(["blue", "green", "purple", "amber", "rose", "slate"]),
    }),
  )
  .max(5);
export const TaskSchema: z.ZodType<Task> = z.object({
  id: z.uuid(),
  text: z.string().trim().min(1).max(2000),
  status: z.enum(["todo", "done", "held"]),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  due: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((v) => {
      const d = new Date(`${v}T12:00:00`);
      return !Number.isNaN(+d) && dateKey(d) === v;
    }, "実在する日付を入力してください")
    .nullable(),
  importance: z.enum(["normal", "high"]),
  minutes: z.number().int().min(1).max(1440),
  holdReason: z.string().max(100).nullable(),
  tags: TagsSchema.optional(),
  source: z.enum(["now", "voice", "chat", "discord", "notion"]).optional(),
  needsReview: z.boolean().optional(),
  notionUrl: z
    .string()
    .url()
    .refine(
      (v) =>
        /^https:\/\/(?:www\.)?notion\.so\//.test(v) ||
        /^https:\/\/app\.notion\.com\//.test(v),
    )
    .optional(),
  project: z.string().max(300).optional(),
});

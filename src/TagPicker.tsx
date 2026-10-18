import { useState } from "react";
import { Plus, Tags, X } from "lucide-react";
import { TAG_COLORS, type Tag } from "../shared/tasks";
export const defaultTags: Tag[] = [
  { name: "仕事", color: "blue" },
  { name: "個人", color: "green" },
  { name: "連絡", color: "purple" },
];
export function TagPill({ tag }: { tag: Tag }) {
  return (
    <span className={`tag-pill tag-${tag.color}`}>
      <i />
      {tag.name}
    </span>
  );
}
export default function TagPicker({
  value,
  options,
  onChange,
}: {
  value: Tag[];
  options: Tag[];
  onChange: (value: Tag[]) => void;
}) {
  const [name, setName] = useState(""),
    [color, setColor] = useState<Tag["color"]>("blue");
  const all = [
    ...new Map(
      [...defaultTags, ...options, ...value].map((t) => [t.name, t]),
    ).values(),
  ];
  const toggle = (tag: Tag) =>
    onChange(
      value.some((t) => t.name === tag.name)
        ? value.filter((t) => t.name !== tag.name)
        : value.length < 5
          ? [...value, tag]
          : value,
    );
  return (
    <details className="tag-picker">
      <summary aria-label="タグを選択">
        <Tags size={14} />
        {value.length ? `タグ ${value.length}` : "タグ"}
      </summary>
      <div className="tag-popover glass">
        <div className="tag-picker-header">
          <span>タグ（最大5つ）</span>
          <button
            type="button"
            className="icon-button"
            aria-label="タグ選択を閉じる"
            onClick={(e) =>
              e.currentTarget.closest("details")?.removeAttribute("open")
            }
          >
            <X size={14} />
          </button>
        </div>
        <div className="tag-options">
          {all.map((t) => (
            <button
              type="button"
              key={t.name}
              aria-pressed={value.some((v) => v.name === t.name)}
              onClick={() => toggle(t)}
            >
              <TagPill tag={t} />
            </button>
          ))}
        </div>
        <div className="tag-create">
          <input
            aria-label="新しいタグ名"
            placeholder="新しいタグ名"
            maxLength={24}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.preventDefault();
            }}
          />
          <button
            type="button"
            aria-label="タグを作成"
            disabled={!name.trim() || value.length >= 5}
            onClick={() => {
              onChange([
                ...value.filter((t) => t.name !== name.trim()),
                { name: name.trim(), color },
              ]);
              setName("");
            }}
          >
            <Plus size={17} />
          </button>
        </div>
        <div className="color-options">
          {TAG_COLORS.map((c, i) => (
            <button
              key={c}
              type="button"
              className={`tag-swatch tag-${c}`}
              aria-label={`タグの色：${["青", "緑", "紫", "オレンジ", "ピンク", "グレー"][i]}`}
              aria-pressed={color === c}
              onClick={() => setColor(c)}
            >
              <i />
            </button>
          ))}
        </div>
      </div>
    </details>
  );
}

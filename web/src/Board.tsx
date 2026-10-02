/** 本人に公開された情報だけで、配置プレビューと対戦盤面を描く。 */
import type {
  Board,
  Knowledge,
  Pose,
  Submarine,
  Torpedo,
} from "../../src/shared/engine";

const arrows = { N: "▲", E: "▶", S: "▼", W: "◀" } as const;

interface Props {
  board: Board;
  self?: Pose | Submarine;
  knowledge?: Knowledge;
  ownTorpedoes?: Torpedo[];
  placementZone?: "host" | "guest";
}

/** 座標をキーにして、向き違いの敵候補を一つのマスへまとめる。 */
function candidateCells(knowledge?: Knowledge): Set<string> {
  return new Set(knowledge?.candidates.map((p) => `${p.x},${p.y}`) ?? []);
}

/** 盤外へはみ出さない固定比率のグリッドと、読み上げ用の要約を返す。 */
export function TacticalBoard({
  board,
  self,
  knowledge,
  ownTorpedoes = [],
  placementZone,
}: Props) {
  const reefs = new Set(board.reefs.map((p) => `${p.x},${p.y}`));
  const candidates = candidateCells(knowledge);
  const latest = knowledge?.observations.at(-1);
  const torpedoes = new Map(ownTorpedoes.map((t) => [`${t.x},${t.y}`, t]));
  const cells = [];
  for (let y = 0; y < board.height; y++) {
    cells.push(
      <span className="axis axis-y" key={`y-${y}`} aria-hidden="true">
        {y}
      </span>,
    );
    for (let x = 0; x < board.width; x++) {
      const key = `${x},${y}`;
      const mine = self?.x === x && self.y === y;
      const torpedo = torpedoes.get(key);
      const observed = latest?.pose.x === x && latest.pose.y === y;
      const reef = reefs.has(key);
      const candidate = candidates.has(key);
      const zone =
        placementZone &&
        (placementZone === "host" ? y < 3 : y >= board.height - 3);
      const kind = mine
        ? "mine"
        : torpedo
          ? "torpedo"
          : observed
            ? "observed"
            : reef
              ? "reef"
              : candidate
                ? "candidate"
                : zone
                  ? "zone"
                  : "water";
      const mark = mine
        ? arrows[self.direction]
        : torpedo
          ? arrows[torpedo.direction]
          : observed
            ? "◎"
            : reef
              ? "×"
              : candidate
                ? "·"
                : "";
      cells.push(
        <span className={`sea-cell sea-${kind}`} key={key} aria-hidden="true">
          {mark}
        </span>,
      );
    }
  }
  const summary = knowledge
    ? `戦術盤 ${board.width}列 ${board.height}行。自艦 ${self?.x}列 ${self?.y}行。敵候補 ${candidates.size}マス。最終観測 ${latest ? `${latest.pose.x}列 ${latest.pose.y}行、第${latest.turn}手` : "なし"}。自分の魚雷 ${ownTorpedoes.length}発。`
    : `配置盤 ${board.width}列 ${board.height}行。選択位置 ${self?.x}列 ${self?.y}行。`;
  return (
    <div className="board-wrap">
      <div
        className="board"
        role="img"
        aria-label={summary}
        style={{
          gridTemplateColumns: `1.25rem repeat(${board.width}, minmax(0, 1fr))`,
        }}
      >
        <span aria-hidden="true" className="axis" />
        {Array.from({ length: board.width }, (_, x) => (
          <span className="axis axis-x" key={`x-${x}`} aria-hidden="true">
            {x}
          </span>
        ))}
        {cells}
      </div>
      <ul className="legend" aria-label="盤面の凡例">
        <li>
          <span className="legend-symbol sea-mine">▲</span> 自艦
        </li>
        <li>
          <span className="legend-symbol sea-candidate">·</span> 敵候補
        </li>
        <li>
          <span className="legend-symbol sea-observed">◎</span> 最終観測
        </li>
        <li>
          <span className="legend-symbol sea-torpedo">▶</span> 自分の魚雷
        </li>
        <li>
          <span className="legend-symbol sea-reef">×</span> 岩礁
        </li>
      </ul>
    </div>
  );
}

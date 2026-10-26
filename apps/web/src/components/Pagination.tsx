import { ChevronLeft, ChevronRight } from "lucide-react";
export function Pagination({
  offset,
  limit,
  total,
  loading,
  onOffset,
  onLimit,
  sizes = [5, 10, 25, 50, 100],
}: {
  offset: number;
  limit: number;
  total: number;
  loading: boolean;
  onOffset: (n: number) => void;
  onLimit: (n: number) => void;
  sizes?: number[];
}) {
  const from = total === 0 ? 0 : Math.min(offset + 1, total);
  const to = Math.min(offset + limit, total);
  return (
    <div className="pagination">
      <div className="pagination-summary" aria-live="polite">
        Showing{" "}
        <strong>
          {from.toLocaleString()}–{to.toLocaleString()}
        </strong>{" "}
        of <strong>{total.toLocaleString()}</strong> actions
      </div>
      <div className="pagination-controls">
        <label>
          Rows per page
          <select
            aria-label="Rows per page"
            value={limit}
            disabled={loading}
            onChange={(e) => onLimit(Number(e.target.value))}
          >
            {sizes.map((size) => (
              <option key={size}>{size}</option>
            ))}
          </select>
        </label>
        <nav aria-label="Pagination">
          <button
            className="button secondary small-button"
            aria-label="Previous page"
            disabled={offset === 0 || loading}
            onClick={() => onOffset(Math.max(0, offset - limit))}
          >
            <ChevronLeft size={15} />
            Previous
          </button>
          <button
            className="button secondary small-button"
            aria-label="Next page"
            disabled={offset + limit >= total || loading}
            onClick={() => onOffset(offset + limit)}
          >
            Next
            <ChevronRight size={15} />
          </button>
        </nav>
      </div>
    </div>
  );
}

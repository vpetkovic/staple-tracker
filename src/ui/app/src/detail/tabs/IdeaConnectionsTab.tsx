/**
 * Connections for an idea: what it is attached to in the plan. Its parent idea, its sub-ideas,
 * the horizon it is scheduled on (a milestone), and the tracker work it is linked to. Each row
 * opens that record in this drawer. An idea is never a blocker or blocked, so there are no
 * dependency edges to draw; the task version of this tab draws those.
 */
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { useSession } from "@/lib/session";
import { Chip } from "@/views/plan/PlanBoards";
import { dayLabel } from "@/views/plan/plan-model";
import { STATE_WORDS, planRecordOf } from "../plan-record";
import type { TabProps } from "./registry";

export function IdeaConnectionsTab({ detail, workspace }: TabProps) {
  const session = useSession();
  const record = planRecordOf(detail);
  if (!record) return null;
  const open = (ref: string) => session.open(workspace, ref);
  const empty = !record.parent && record.children.length === 0 && !record.horizon && record.linked.length === 0;
  return (
    <div className="space-y-5" data-idea-connections={record.idea.id}>
      {empty ? <p className="m-0 text-body text-text-secondary">Nothing is attached yet: no parent idea, no sub-ideas, no horizon and no linked work.</p> : null}
      {record.parent ? (
        <Group label="Part of">
          <Row onOpen={() => open(record.parent!.identifier ?? record.parent!.id)} testId="parent">
            {record.parent.title}
          </Row>
        </Group>
      ) : null}
      {record.horizon ? (
        <Group label="Horizon">
          <Row onOpen={() => open(record.horizon!.identifier)} testId="horizon" trailing={<Chip>{STATE_WORDS[record.horizon.state]?.toLowerCase()}</Chip>}>
            {record.horizon.name}
            {record.horizon.date ? <span className="text-text-tertiary"> · {dayLabel(record.horizon.date)}</span> : null}
          </Row>
        </Group>
      ) : null}
      {record.children.length > 0 ? (
        <Group label={`Sub-ideas (${record.children.length})`}>
          {record.children.map((child) => (
            <Row key={child.id} onOpen={() => open(child.identifier ?? child.id)} testId="child" trailing={<Chip>{STATE_WORDS[child.state]?.toLowerCase()}</Chip>}>
              {child.title}
            </Row>
          ))}
        </Group>
      ) : null}
      {record.linked.length > 0 ? (
        <Group label={`Linked work (${record.linked.length})`}>
          {record.linked.map((link) => (
            <Row key={link.id} onOpen={link.missing ? undefined : () => open(link.identifier)} testId="link" trailing={<span className="text-caption text-text-tertiary">{link.missing ? "missing" : link.status}</span>}>
              <span className="font-mono text-text-tertiary">{link.missing ? link.id : link.identifier}</span> {link.title}
            </Row>
          ))}
        </Group>
      ) : null}
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-caption font-semibold tracking-wide text-text-tertiary uppercase">{label}</h3>
      <ul className="m-0 list-none space-y-1 p-0">{children}</ul>
    </section>
  );
}

function Row({ children, onOpen, trailing, testId }: { children: ReactNode; onOpen?: () => void; trailing?: ReactNode; testId: string }) {
  const body = (
    <>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
      {onOpen ? <ChevronRight aria-hidden className="size-4 shrink-0 text-text-tertiary" /> : null}
    </>
  );
  return (
    <li data-idea-connection={testId}>
      {onOpen ? (
        <button type="button" onClick={onOpen} className="focus-ring flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left text-label hover:bg-surface-hover">
          {body}
        </button>
      ) : (
        <div className="flex min-h-10 items-center gap-2 px-2 text-label">{body}</div>
      )}
    </li>
  );
}

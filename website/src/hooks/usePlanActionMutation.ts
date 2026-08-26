import { useCallback } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../api/client'

/**
 * The only actions the plan endpoint accepts (chat_orchestrator's plan-action
 * handler lowercases and checks against exactly this set; anything else is a
 * 400). The plan pipeline normalizes every plan footer to
 * `[OPTION: Go | Go All | Cancel]` before it reaches a transcript, so these
 * are also the only labels a real plan chip can carry.
 */
const PLAN_ACTIONS = new Set(['go', 'go all', 'cancel'])

/**
 * True when a follow-up chip label is an actual plan action. Hosts gate their
 * plan-dispatch branch on this so a plan-SHAPED message with non-protocol
 * labels (e.g. an agent quoting a plan and offering its own choices) falls
 * through to the normal composer path instead of firing a dispatch the server
 * would reject — a rejected dispatch skips the append path too, leaving a
 * dead chip.
 */
export function isPlanAction(label: string): boolean {
  return PLAN_ACTIONS.has(label.trim().toLowerCase())
}

const isCancel = (action: string) => action.trim().toLowerCase() === 'cancel'

/**
 * Slots with a STAGE-ADVANCING dispatch (Go / Go All) in flight. Module-level
 * on purpose, for two reasons the per-render mutation state cannot cover:
 *
 * 1. `mutation.isPending` is a render-time snapshot — two chip clicks landing
 *    before the next render both read `false` and both dispatch. This latch
 *    is synchronous: set before `mutate`, cleared in `onSettled`.
 * 2. One session can occupy two grid panes (the session grid does not enforce
 *    slot uniqueness across leaves). Each pane holds its own hook instance,
 *    so an instance-local guard in pane A would not stop pane B from queueing
 *    a second `Go` and advancing an extra stage.
 *
 * Cancel deliberately IGNORES the latch in both directions: it is the stop
 * control (dropping it while a Go is in flight would swallow the user's abort
 * of the very action being latched), the server's cancel path is re-entrant
 * (`if tracker and not tracker.stopped`), and a settling Cancel must not
 * release a latch it never took.
 */
const inFlightBySlot = new Set<string>()

/**
 * Dispatches an orchestrator plan follow-up (Go / Go All / Cancel) to
 * `POST /api/chat/slots/{slot}/plan-action` — the slot-scoped endpoint behind
 * `api.planAction`.
 *
 * One hook, one convention: ChatPage and ChatPane render the same plan chips
 * via `deriveFollowUpOptions`, and the same chip must mean the same thing on
 * both surfaces (#5893: ChatPane used to drop `followUpIsPlan` and let an
 * approval label fall through to the composer as ordinary text). `mutate` is
 * a per-slot single-flight for the stage-advancing actions: a second Go / Go
 * All while one is already in flight for the same slot is dropped (it would
 * queue and advance an extra stage), while Cancel always goes through. This
 * matches the hosts' `isPending` guard but is immune to the render-snapshot
 * race and to the same slot being mounted in two panes.
 *
 * `mutateAsync` is deliberately NOT exposed: it would bypass the single-flight
 * this hook exists to guarantee.
 *
 * Fire-and-forget beyond that: no onSuccess invalidation (the plan advances
 * over the event stream); a failed dispatch is logged to the console and
 * surfaces through the mutation state for any host that chooses to render it.
 */
export function usePlanActionMutation() {
  const mutation = useMutation({
    mutationFn: ({ slot, action }: { slot: string; action: string }) => api.planAction(slot, action),
    onError: (e) => { console.error('plan action failed', e) },
    onSettled: (_d, _e, vars) => { if (!isCancel(vars.action)) inFlightBySlot.delete(vars.slot) },
  })
  const { mutate: rawMutate } = mutation
  const mutate = useCallback((vars: { slot: string; action: string }) => {
    if (!isCancel(vars.action)) {
      if (inFlightBySlot.has(vars.slot)) return
      inFlightBySlot.add(vars.slot)
    }
    rawMutate(vars)
  }, [rawMutate])
  const { mutateAsync: _dropped, ...rest } = mutation
  return { ...rest, mutate }
}

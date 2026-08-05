import type { Round } from "./round";

/**
 * A small sample round, so the sheet isn't empty on first load.
 *
 * Two sheets rather than one, because one sheet doesn't look like a debate: a
 * round is flowed as a stack of positions, and the case and the topicality
 * violation are the two you can count on being there.
 *
 * Kept apart from the format (see format.ts) because it is scaffolding: it goes
 * away the day a round is opened from disk rather than invented at startup.
 */

export function seedSample(round: Round): void {
  const caseSheet = round.addSheet("Case");
  const flow = round.flow(caseSheet);
  // One batch, so it lands as a single change rather than six.
  flow.batch(() => {
    const econ = flow.addRoot(null, "Plan tanks the economy", 0);
    flow.addResponse(econ, "No internal link — spending is offset");
    const war = flow.addResponse(econ, "Econ decline → great-power war");
    flow.addResponse(war, "Interdependence checks escalation", 2);

    const warming = flow.addRoot(null, "Solves warming: -2C by 2050", 0);
    flow.addResponse(warming, "Too slow — tipping points already passed");
  });

  const topicality = round.addSheet("T-Substantial");
  const t = round.flow(topicality);
  t.batch(() => {
    const violation = t.addRoot(null, "T — substantial means 2% of GDP", 1);
    t.addResponse(violation, "We meet — plan is 4%", 2);
    t.addResponse(violation, "Counter-interp: substantial = without conditions", 2);
  });
}

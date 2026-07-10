import assert from "node:assert/strict";
import { test } from "node:test";
import { assertImmutableReleaseTagRuleset } from "./verify-release-ruleset.mjs";

const immutableRuleset = {
  id: 42,
  name: "Immutable release tags",
  target: "tag",
  enforcement: "active",
  bypass_actors: [],
  current_user_can_bypass: "never",
  conditions: {
    ref_name: {
      include: ["refs/tags/v*"],
      exclude: []
    }
  },
  rules: [{ type: "update" }, { type: "deletion" }]
};

test("release ruleset verification accepts active immutable v tags", () => {
  assert.doesNotThrow(() => assertImmutableReleaseTagRuleset([immutableRuleset], "v1.2.3"));
});

test("release ruleset verification rejects update or deletion gaps", () => {
  assert.throws(
    () => assertImmutableReleaseTagRuleset([{ ...immutableRuleset, rules: [{ type: "deletion" }] }], "v1.2.3"),
    /immutable active tag ruleset/i
  );
  assert.throws(
    () => assertImmutableReleaseTagRuleset([{ ...immutableRuleset, rules: [{ type: "update" }] }], "v1.2.3"),
    /immutable active tag ruleset/i
  );
});

test("release ruleset verification rejects bypass actors and nonmatching refs", () => {
  assert.throws(
    () => assertImmutableReleaseTagRuleset([{ ...immutableRuleset, current_user_can_bypass: "always" }], "v1.2.3"),
    /immutable active tag ruleset/i
  );
  assert.throws(
    () => assertImmutableReleaseTagRuleset([{ ...immutableRuleset, bypass_actors: [{ actor_type: "RepositoryRole", actor_id: 5 }] }], "v1.2.3"),
    /immutable active tag ruleset/i
  );
  assert.throws(
    () =>
      assertImmutableReleaseTagRuleset(
        [{ ...immutableRuleset, conditions: { ref_name: { include: ["refs/tags/release-*"], exclude: [] } } }],
        "v1.2.3"
      ),
    /immutable active tag ruleset/i
  );
});

test("release ruleset verification fails closed when any ref exclusion is configured", () => {
  assert.throws(
    () =>
      assertImmutableReleaseTagRuleset(
        [{ ...immutableRuleset, conditions: { ref_name: { include: ["~ALL"], exclude: ["refs/tags/v0.*"] } } }],
        "v0.1.3"
      ),
    /immutable active tag ruleset/i
  );
});

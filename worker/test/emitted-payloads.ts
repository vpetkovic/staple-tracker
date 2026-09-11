/**
 * One real payload per entity and verb the workspace client emits (STA-262). GENERATED.
 *
 * `test/cloud-emitter-payloads.test.ts` drives every emitter — the seed, the journal
 * seam through every store, the lease claim, and the conflict resolver's three verbs —
 * through the real sync engine into the fake service, and compares what arrived with
 * this list. `worker/test/push.test.ts` pushes every entry through the real Worker. So a
 * payload a real emitter sends and the Worker refuses fails one suite or the other.
 *
 * Minted ids are replaced with one fixed UUID and wall-clock times with one fixed time,
 * so the list is stable from run to run. Nothing else is touched.
 *
 * Do not edit by hand. Regenerate from the repository root with
 *
 *     STAPLE_WRITE_EMITTED_PAYLOADS=1 npx vitest run test/cloud-emitter-payloads.test.ts
 *
 * NO IMPORTS, for the same reason as `registry-fixture.ts`: it is the one kind of file
 * both tsconfigs can compile.
 */

export const EMITTED_PAYLOADS: ReadonlyArray<{
  entity: string;
  verb: string;
  payload: Record<string, unknown>;
}> = [
  {
    "entity": "comment",
    "verb": "create",
    "payload": {
      "issueId": "00000000-0000-4000-8000-000000000000",
      "author": "past",
      "authorType": "user",
      "body": "an old comment",
      "idempotencyKey": null,
      "deletedAt": null,
      "createdAt": "2026-09-10T00:00:00.000Z"
    }
  },
  {
    "entity": "conflict",
    "verb": "update",
    "payload": {
      "resolvedAt": "2026-09-10T00:00:00.000Z",
      "resolvedBy": "vp",
      "value": [
        "00000000-0000-4000-8000-000000000000",
        "00000000-0000-4000-8000-000000000000"
      ],
      "entity": "queue",
      "targetId": "@plan",
      "field": "order"
    }
  },
  {
    "entity": "documentRevision",
    "verb": "create",
    "payload": {
      "issueId": "00000000-0000-4000-8000-000000000000",
      "key": "notes",
      "revision": 1,
      "body": "old notes",
      "title": null,
      "changeSummary": null,
      "author": "past",
      "createdAt": "2026-09-10T00:00:00.000Z"
    }
  },
  {
    "entity": "issue",
    "verb": "create",
    "payload": {
      "identifier": "TST-1",
      "title": "Old epic",
      "normalizedTitle": "old epic",
      "description": null,
      "status": "backlog",
      "statusVersion": 0,
      "priority": "medium",
      "parentId": null,
      "depth": 0,
      "assignee": null,
      "createdBy": null,
      "labels": [
        "old"
      ],
      "acceptanceCriteria": null,
      "blockParentUntilDone": false,
      "unblockOwner": null,
      "unblockAction": null,
      "originKind": "manual",
      "originId": null,
      "idempotencyKey": null,
      "estimatedSeconds": null,
      "kind": "epic",
      "projectId": null,
      "gateState": null,
      "gateOwner": null,
      "gateRequestedBy": null,
      "gateRequestedAt": null,
      "gateResolvedBy": null,
      "gateResolvedAt": null,
      "gateReleased": false,
      "startedAt": null,
      "blockedTransitionAt": null,
      "completedAt": null,
      "cancelledAt": null,
      "checkoutAgent": null,
      "checkoutAt": null,
      "createdAt": "2026-09-10T00:00:00.000Z",
      "updatedAt": "2026-09-10T00:00:00.000Z"
    }
  },
  {
    "entity": "issue",
    "verb": "renumber",
    "payload": {
      "identifier": "TST-14"
    }
  },
  {
    "entity": "issue",
    "verb": "update",
    "payload": {
      "updatedAt": "2026-09-10T00:00:00.000Z",
      "title": "Child, renamed",
      "priority": "low",
      "labels": "[]",
      "normalizedTitle": "child, renamed"
    }
  },
  {
    "entity": "kind",
    "verb": "create",
    "payload": {
      "id": "research",
      "label": "Research",
      "isBuiltin": false
    }
  },
  {
    "entity": "kind",
    "verb": "delete",
    "payload": {
      "migrateTo": "milestone"
    }
  },
  {
    "entity": "kind",
    "verb": "update",
    "payload": {
      "label": "Experiment"
    }
  },
  {
    "entity": "lease",
    "verb": "create",
    "payload": {
      "fencingToken": 1,
      "holder": "emitter",
      "deviceId": "device-a",
      "serverExpiresAt": "2026-09-10T00:00:00.000Z",
      "acquiredAt": "2026-09-10T00:00:00.000Z"
    }
  },
  {
    "entity": "lease",
    "verb": "delete",
    "payload": {
      "fencingToken": 1,
      "holder": "emitter"
    }
  },
  {
    "entity": "milestone",
    "verb": "create",
    "payload": {
      "members": [
        "00000000-0000-4000-8000-000000000000"
      ],
      "entries": {
        "00000000-0000-4000-8000-000000000001": {
          "addedBy": "past",
          "addedAt": "2026-09-10T00:00:00.000Z",
          "note": null
        }
      },
      "targetDate": null,
      "startDate": "2026-01-01",
      "updatedAt": "2026-09-10T00:00:00.000Z"
    }
  },
  {
    "entity": "milestone",
    "verb": "replace",
    "payload": {
      "members": [
        "00000000-0000-4000-8000-000000000000"
      ],
      "entries": {
        "00000000-0000-4000-8000-000000000001": {
          "addedBy": "emitter",
          "addedAt": "2026-09-10T00:00:00.000Z",
          "note": null
        }
      },
      "updatedAt": "2026-09-10T00:00:00.000Z"
    }
  },
  {
    "entity": "milestone",
    "verb": "update",
    "payload": {
      "targetDate": "2026-12-01",
      "startDate": null,
      "updatedAt": "2026-09-10T00:00:00.000Z"
    }
  },
  {
    "entity": "project",
    "verb": "create",
    "payload": {
      "slug": "old-project",
      "name": "Old project",
      "kind": "unmanaged",
      "sourceKind": null,
      "source": null,
      "createdAt": "2026-09-10T00:00:00.000Z",
      "updatedAt": "2026-09-10T00:00:00.000Z"
    }
  },
  {
    "entity": "project",
    "verb": "delete",
    "payload": {}
  },
  {
    "entity": "project",
    "verb": "update",
    "payload": {
      "name": "Project, renamed",
      "updatedAt": "2026-09-10T00:00:00.000Z"
    }
  },
  {
    "entity": "queue",
    "verb": "create",
    "payload": {
      "order": [
        "00000000-0000-4000-8000-000000000000"
      ],
      "entries": {
        "00000000-0000-4000-8000-000000000001": {
          "addedBy": "past",
          "addedAt": "2026-09-10T00:00:00.000Z",
          "note": null
        }
      }
    }
  },
  {
    "entity": "queue",
    "verb": "replace",
    "payload": {
      "order": [
        "00000000-0000-4000-8000-000000000000",
        "00000000-0000-4000-8000-000000000000"
      ],
      "entries": {
        "00000000-0000-4000-8000-000000000001": {
          "addedBy": "past",
          "addedAt": "2026-09-10T00:00:00.000Z",
          "note": null
        },
        "00000000-0000-4000-8000-000000000002": {
          "addedBy": "emitter",
          "addedAt": "2026-09-10T00:00:00.000Z",
          "note": null
        }
      }
    }
  },
  {
    "entity": "relation",
    "verb": "create",
    "payload": {
      "blockedBy": [
        "00000000-0000-4000-8000-000000000000"
      ],
      "edges": {
        "00000000-0000-4000-8000-000000000001": {
          "createdBy": "past",
          "createdAt": "2026-09-10T00:00:00.000Z"
        }
      }
    }
  },
  {
    "entity": "relation",
    "verb": "update",
    "payload": {
      "blockedBy": [
        "00000000-0000-4000-8000-000000000000"
      ],
      "edges": {
        "00000000-0000-4000-8000-000000000001": {
          "createdBy": "emitter",
          "createdAt": "2026-09-10T00:00:00.000Z"
        }
      }
    }
  },
  {
    "entity": "setting",
    "verb": "create",
    "payload": {
      "value": "research"
    }
  },
  {
    "entity": "setting",
    "verb": "delete",
    "payload": {}
  },
  {
    "entity": "setting",
    "verb": "update",
    "payload": {
      "value": "strict"
    }
  },
  {
    "entity": "status",
    "verb": "create",
    "payload": {
      "id": "parked",
      "label": "Parked",
      "category": "blocked",
      "isBuiltin": false
    }
  },
  {
    "entity": "status",
    "verb": "delete",
    "payload": {
      "migrateTo": "todo"
    }
  },
  {
    "entity": "status",
    "verb": "update",
    "payload": {
      "label": "Triage"
    }
  }
];

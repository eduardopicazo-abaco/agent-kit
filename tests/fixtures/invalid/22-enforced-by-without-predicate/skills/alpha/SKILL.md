---
name: alpha
description: >-
  Human-started command: it runs only when the human's message begins with `/ak:alpha`. On any other
  request do not load or follow it; tell the human to type that command. Runs the alpha workflow
  when a human asks for it.
---

# Alpha

Run the workflow, then record the receipt.

## When to use

When a human asks for the alpha workflow on a ticket that already exists.

## Not for

Not for a request that names no ticket. Not for a second run against a ticket that already carries
a receipt. Not for a request to edit a file.

## Authority

Authority: `explicit`. A human starts it.

## Inputs

The ticket the request names. Absent: stop and report `needs-input`.

## Workflow

1. Check how this run was started. It is started only when the human's message begins with
   `/ak:alpha`. Otherwise stop, name the command and do nothing else.
2. Read the named ticket and record its id.
3. Produce the receipt and return it.

## Hard gates

Gate: no ticket, no run.

| The thought | Why it is wrong | Do this instead |
|---|---|---|
| "The ticket is obviously the one just discussed." | A ticket named in conversation is not a ticket that exists. | Stop and report `needs-input`. |

## Outputs

One receipt, published through the knowledgebase adapter.

## Side effects

`artifact-write`.

## Stop conditions

Stop when the workflow has produced its receipt.

## Limits

Runs per ticket: 1 (gate).

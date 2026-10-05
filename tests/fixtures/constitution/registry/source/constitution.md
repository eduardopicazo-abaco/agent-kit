# The seed exchange engineering constitution

This document is invented for agent-kit's tests.
It is not taken from, and does not paraphrase, any organization's constitution.
The seed exchange, its stock ledger and its catalogue do not exist.
Each sentence sits on its own line so an article's quote is one line of this file.

## 1. Safety

Nobody pushes to the default branch; every change reaches it through a reviewed pull request.

Secrets never enter a repository, not even in a branch that will be deleted.

A migration that drops or rewrites stored data ships with a rollback plan that a second person has read.
Scratch schemas that hold no customer data are exempt.

## 2. Data

Seed stock is counted in whole grams and stored as integers; a floating-point number never holds a stock quantity.

Every write to the stock ledger carries an idempotency key, so a retried request records once.

## 3. Failure

When something fails, say so: a silent fallback hides the fault from the people who could fix it.
Telemetry that nobody acts on may drop events quietly.

Where staying up and saying so disagree, saying so wins for anything that writes to the stock ledger.

Retry at most three times, waiting longer each time.

## 4. Availability

The catalogue stays readable when a dependency it does not need for reading is down.

## 5. Tests

A bug fix arrives with a test that failed before the fix.

Test what the code does, not how it does it.

## 6. Code

Name things for what they are.

## 7. Operations

Every scheduled job writes a line when it starts and a line when it ends.

# Synthetic Reflection: Validate Before Declaring Completion

- final_severity: Major
- responsibility: agent_fault

## Facts Proven By Context

- A synthetic check was reported as complete before its required verification ran.

## User Complaint In Plain Language

The result should have been verified before it was described as complete.

## Root Cause

The workflow treated an implementation result as verification evidence.

## Class Of Mistake

Completion claims made without fresh verification evidence

## Method Change

1. Run the required verification command immediately before reporting completion.
2. Report the observed result rather than an inferred result.

## Repeated Pattern Evidence

- none

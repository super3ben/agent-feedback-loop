# 2026-01-02 Synthetic Export Reflection

final_severity: Blocker
responsibility: agent_fault

## Facts Proven By Context

- A synthetic export operation crossed its declared test boundary.

## User Complaint

The export must remain inside the disposable test directory.

## Root Cause

The boundary was assumed instead of checked.

## Repeated Pattern Evidence

- none

## Preventive Constraint

Before an export, verify that the destination is the owned disposable directory.

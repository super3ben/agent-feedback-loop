#!/usr/bin/env node
/**
 * Net effect: the family's own change minus the project's overall change.
 *
 * session-recurrence.mjs shows a lesson's family falling after delivery. That is
 * not enough. Work shifts: a feature stabilises, the user moves to another area,
 * and every family in the project gets quieter for reasons that have nothing to
 * do with any lesson. Measuring the family alone cannot separate the two.
 *
 * So each delivered family is compared against ITS OWN PROJECT over the same
 * window. The project figure is the control: whatever share of the fall is
 * explained by the project's overall drift is subtracted, and what remains is the
 * only number that can be attributed to the lesson.
 *
 * Usage: node eval/net-effect.mjs [--days=14] [--json]
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
const db = new DatabaseSync(path.join(process.env.HOME, ".agent/feedback-loop-data/store/control.sqlite3"), { readOnly: true });
const DAY=86400000, W=14*DAY;

const del = db.prepare(`
  SELECT job.family_key AS family, job.project_id AS project, MIN(e.emitted_at) AS at
  FROM reflection_emissions e JOIN reviewer_jobs job ON job.published_path=e.document_path
  WHERE e.outcome='emitted' AND e.emitted_at IS NOT NULL AND job.family_key IS NOT NULL AND job.family_key<>''
  GROUP BY job.family_key, job.project_id`).all();

const famSessions = db.prepare(`SELECT COUNT(DISTINCT se.session_uid) n FROM reviewer_jobs j
  JOIN session_events se ON se.event_uid=j.source_event_uid
  WHERE j.family_key=? AND j.project_id=? AND j.created_at>=? AND j.created_at<?`);
const projActivity = db.prepare(`SELECT COUNT(DISTINCT se.session_uid) n FROM reviewer_jobs j
  JOIN session_events se ON se.event_uid=j.source_event_uid
  WHERE j.project_id=? AND j.created_at>=? AND j.created_at<? AND j.family_key IS NOT NULL AND j.family_key<>''`);

const rows=[];
for(const d of del){
  const at=Date.parse(d.at); if(!Number.isFinite(at)) continue;
  const fB=famSessions.get(d.family,d.project,new Date(at-W).toISOString(),new Date(at).toISOString()).n;
  const fA=famSessions.get(d.family,d.project,new Date(at).toISOString(),new Date(at+W).toISOString()).n;
  if(fB===0) continue;
  const pB=projActivity.get(d.project,new Date(at-W).toISOString(),new Date(at).toISOString()).n;
  const pA=projActivity.get(d.project,new Date(at).toISOString(),new Date(at+W).toISOString()).n;
  if(pB<10) continue;
  const famChange=(fA-fB)/fB;          // 家族自身变化
  const projChange=(pA-pB)/pB;         // 项目整体变化（对照）
  rows.push({family:d.family, fB,fA, famChange, projChange, net: famChange-projChange});
}

const mean=v=>v.length? v.reduce((a,b)=>a+b,0)/v.length:0;
const med=v=>v.length? [...v].sort((a,b)=>a-b)[Math.floor(v.length/2)]:0;

const netBetter = rows.filter(r=>r.net < 0).length;
console.log(`=== 净效果（家族变化 − 同期项目整体变化）===`);
console.log(`样本: ${rows.length} 个家族-项目组合\n`);
console.log(`家族自身变化:   均值 ${(100*mean(rows.map(r=>r.famChange))).toFixed(1)}%  中位 ${(100*med(rows.map(r=>r.famChange))).toFixed(1)}%`);
console.log(`项目整体变化:   均值 ${(100*mean(rows.map(r=>r.projChange))).toFixed(1)}%  中位 ${(100*med(rows.map(r=>r.projChange))).toFixed(1)}%`);
console.log(`净效果:         均值 ${(100*mean(rows.map(r=>r.net))).toFixed(1)}%  中位 ${(100*med(rows.map(r=>r.net))).toFixed(1)}%`);
console.log(`\n扣掉项目趋势后仍然改善: ${netBetter}/${rows.length}  ${Math.round(100*netBetter/rows.length)}%`);

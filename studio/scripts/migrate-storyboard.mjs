/** One-time migration of a legacy embedded storyboard. Run with Studio's
 * normal Firebase Admin / Pyric environment. The source stays until explicitly
 * removed after verification. Existing standalone edits are never overwritten. */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const [id, action = 'copy'] = process.argv.slice(2);
if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || !['copy','remove-empty-source'].includes(action)) throw Error('Usage: migrate-storyboard.mjs <production-id> [copy|remove-empty-source]');
for (const path of ['.env.local','.env']) if (fs.existsSync(path)) process.loadEnvFile(path);
if (!getApps().length) initializeApp({projectId:process.env.FIREBASE_PROJECT_ID ?? process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,storageBucket:process.env.FIREBASE_STORAGE_BUCKET ?? process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET});
const db=getFirestore();
const source=db.collection('productions').doc(id);
const target=db.collection('storyboards').doc(id);
const fingerprint=data=>createHash('sha256').update(JSON.stringify([data.ownerUid,data.title,data.storyboard])).digest('hex');
const snapshot=await source.get();
if(!snapshot.exists) throw Error('Source production is missing. Nothing changed.');
const data=snapshot.data();
if(!data.storyboard?.document || !data.ownerUid) throw Error('Source has no saved storyboard. Nothing changed.');
// Keep a private recovery copy outside the repository before either operation.
const backup=`/tmp/mdmedia-storyboard-migration-${id}.json`;
if(!fs.existsSync(backup)) fs.writeFileSync(backup,JSON.stringify(data,null,2),{mode:0o600});
const sourceFingerprint=fingerprint(data);
if(action==='copy') {
  await db.runTransaction(async tx=>{
    const [old,saved]=await Promise.all([tx.get(source),tx.get(target)]);
    const current=old.data();
    if(!current || fingerprint(current)!==sourceFingerprint) throw Error('Source changed; rerun after review.');
    if(saved.exists){
      if(saved.data()?.ownerUid!==current.ownerUid || saved.data()?.migratedFrom?.sourceFingerprint!==sourceFingerprint) throw Error('An independent storyboard already uses this id. Nothing overwritten.');
      return;
    }
    tx.set(target,{ownerUid:current.ownerUid,title:current.title,createdAt:current.createdAt,updatedAt:current.updatedAt,storyboard:current.storyboard,migratedFrom:{productionId:id,sourceFingerprint}});
  });
} else {
  await db.runTransaction(async tx=>{
    const [old,saved,cuts]=await Promise.all([tx.get(source),tx.get(target),tx.get(db.collection(`productions/${id}/cuts`).limit(1))]);
    const current=old.data(), migrated=saved.data();
    if(!current || !migrated || migrated.ownerUid!==current.ownerUid || migrated.migratedFrom?.sourceFingerprint!==fingerprint(current)) throw Error('Verified migration not found or source changed. Nothing removed.');
    if(!cuts.empty || current.cuts?.length || current.cast?.length || current.seriesId || current.coverAssetId || current.currentCutId || current.approvedCutId) throw Error('Production contains production work. Nothing removed.');
    tx.delete(source);
  });
}
console.log(JSON.stringify({action,id,backup}));

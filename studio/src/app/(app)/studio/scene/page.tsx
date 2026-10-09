"use client";
import {useSearchParams} from 'next/navigation';
import { SceneComposer } from "@/components/scene/scene-composer";
import {ImportedScene} from '@/components/projects/imported-project';
export default function ScenePage() {
  const projectId=useSearchParams().get('project');
  return projectId?<ImportedScene projectId={projectId}/>:<SceneComposer/>;
}

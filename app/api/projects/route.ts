import { NextResponse } from 'next/server';
import { fetchProjectData } from '@/lib/project-data';

export async function GET() {
  const data = await fetchProjectData();
  const tasks: any[] = [];
  for (const [projectName, projectTasks] of Object.entries(data.projects)) {
    for (const task of projectTasks) {
      task.project = projectName;
      tasks.push(task);
    }
  }
  return NextResponse.json({ tasks, priorities: data.priorities });
}

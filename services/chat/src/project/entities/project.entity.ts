export class ProjectEntity {
  id!: string;
  userId!: string;
  name!: string;
  description!: string | null;
  isDeleted!: boolean;
  createdAt!: Date;
  updatedAt!: Date;
  canvases?: {
    id: string;
    name: string;
    createdAt: Date;
  }[];
}

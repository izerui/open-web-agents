export interface Group {
  id: string;
  name: string;
  description?: string;
  ownerId: string;
  createdAt: number;
}

export interface GroupMember {
  userId: string;
  email: string;
  joinedAt: number;
}

export interface NewGroup {
  id: string;
  name: string;
  description?: string;
  ownerId: string;
}

export interface GroupRepo {
  create(g: NewGroup): Promise<Group>;
  get(id: string): Promise<Group | null>;
  /** 列出某人可管理的组(自己建的);admin 传 undefined 看全部。 */
  list(ownerId?: string): Promise<Group[]>;
  delete(id: string): Promise<void>;

  /** 某用户所属的组 id —— 授权判定要用,是热路径。 */
  groupIdsOf(userId: string): Promise<string[]>;
  members(groupId: string): Promise<GroupMember[]>;
  addMember(groupId: string, userId: string): Promise<void>;
  removeMember(groupId: string, userId: string): Promise<void>;
}

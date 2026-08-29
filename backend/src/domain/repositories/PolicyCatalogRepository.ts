export interface ProfileRecord { id:number; name:string; description:string|null; downloadLimit:bigint|null; uploadLimit:bigint|null; quota:bigint|null; quotaPeriod:string|null; }
export interface ScheduleRuleRecord { id:number; dayOfWeek:number; startTime:string; endTime:string; downloadLimit:bigint|null; uploadLimit:bigint|null; blocked:boolean|null; }
export interface ScheduleRecord { id:number; name:string; description:string|null; rules:ScheduleRuleRecord[]; }
export interface PortRuleRecord { id:number; deviceId:number; name:string; protocol:string; port:number; action:string; enabled:boolean; }

export interface PolicyCatalogRepository {
  profiles(): Promise<ProfileRecord[]>;
  createProfile(data: Omit<ProfileRecord,"id">): Promise<ProfileRecord>;
  updateProfile(id:number,data:Partial<Omit<ProfileRecord,"id">>): Promise<ProfileRecord>;
  deleteProfile(id:number): Promise<void>;
  schedules(): Promise<ScheduleRecord[]>;
  createSchedule(data:{name:string;description:string|null;rules:Array<Omit<ScheduleRuleRecord,"id">>}): Promise<ScheduleRecord>;
  updateSchedule(id:number,data:{name?:string;description?:string|null;rules?:Array<Omit<ScheduleRuleRecord,"id">>}): Promise<ScheduleRecord>;
  deleteSchedule(id:number): Promise<void>;
  portRules(deviceId:number): Promise<PortRuleRecord[]>;
  portRule(id:number): Promise<PortRuleRecord|null>;
  createPortRule(data:Omit<PortRuleRecord,"id">): Promise<PortRuleRecord>;
  deletePortRule(id:number): Promise<void>;
}

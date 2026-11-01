import { repository } from "../ideas/access";
import { Operations } from "../ideas/operations";
import { operationalDB } from "../ideas/runtime";
import { ImportJobStore } from "./job-store";
import { ImportJobService } from "./job-service";
export function importJobStore() {
  return new ImportJobStore(operationalDB());
}
export function importJobService() {
  const db = operationalDB();
  return new ImportJobService(
    new ImportJobStore(db),
    repository(),
    new Operations(db),
  );
}

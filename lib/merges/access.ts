import { notionConfig, operationalDB } from "../ideas/runtime";
import { Operations } from "../ideas/operations";
import { MergeRepository } from "./repository";
import { MergeService } from "./service";
export const mergeService = () =>
  new MergeService(
    new MergeRepository(notionConfig()),
    new Operations(operationalDB()),
  );

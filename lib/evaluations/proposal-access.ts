import { notionConfig, operationalDB } from "../ideas/runtime";
import { Operations } from "../ideas/operations";
import { AssessmentRepository } from "./proposal-repository";
import { AssessmentService } from "./proposal-service";
export const assessmentRepository = () =>
  new AssessmentRepository(notionConfig());
export const assessmentService = () =>
  new AssessmentService(
    assessmentRepository(),
    new Operations(operationalDB()),
  );

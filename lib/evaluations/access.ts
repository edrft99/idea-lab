import { notionConfig, operationalDB } from "../ideas/runtime";
import { Operations } from "../ideas/operations";
import { EvaluationRepository } from "./repository";
import { EvaluationService } from "./service";
export function evaluationService() {
  return new EvaluationService(
    new EvaluationRepository(notionConfig()),
    new Operations(operationalDB()),
  );
}

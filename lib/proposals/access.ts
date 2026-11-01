import { notionConfig, operationalDB } from "../ideas/runtime";
import { Operations } from "../ideas/operations";
import { ProposalRepository } from "./repository";
import { ProposalService } from "./service";
export const proposalRepository = () => new ProposalRepository(notionConfig());
export const proposalService = () =>
  new ProposalService(proposalRepository(), new Operations(operationalDB()));

import { notionConfig, operationalDB } from "../ideas/runtime";
import { Operations } from "../ideas/operations";
import { LinkRepository } from "./repository";
import { LinkService } from "./service";
export const linkService = () =>
  new LinkService(
    new LinkRepository(notionConfig()),
    new Operations(operationalDB()),
  );

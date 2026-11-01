import { notionConfig, operationalDB } from "../ideas/runtime";
import { Operations } from "../ideas/operations";
import { ReviewRepository } from "./repository";
import { ReviewService } from "./service";
export const reviewRepository = () => new ReviewRepository(notionConfig());
export const reviewService = () =>
  new ReviewService(reviewRepository(), new Operations(operationalDB()));

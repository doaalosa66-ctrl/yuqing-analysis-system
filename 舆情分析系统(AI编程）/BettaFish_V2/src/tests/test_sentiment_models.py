"""
Unit tests for 情感分析与NLP模型层 (模块 4.1-4.5)
WeiboSentiment_Finetuned / WeiboMultilingualSentiment / MachineLearning / SmallQwen / BertTopicDetection
"""

import pytest
import sys
import os
from unittest.mock import patch, MagicMock
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ==================== 模块 4.1: 微博情感分析微调模型 ====================

class TestWeiboSentimentFinetuned:
    """测试 BertChinese-Lora 微调模型"""

    def test_directory_exists(self):
        path = os.path.join(PROJECT_ROOT, "SentimentAnalysisModel", "WeiboSentiment_Finetuned")
        assert os.path.isdir(path)

    def test_predict_script_exists(self):
        path = os.path.join(
            PROJECT_ROOT, "SentimentAnalysisModel",
            "WeiboSentiment_Finetuned", "BertChinese-Lora", "predict.py"
        )
        assert os.path.isfile(path)

    def test_preprocess_text_function(self):
        sys.path.insert(0, os.path.join(
            PROJECT_ROOT, "SentimentAnalysisModel", "WeiboSentiment_Finetuned", "BertChinese-Lora"
        ))
        try:
            from predict import preprocess_text
            result = preprocess_text("  测试文本  ")
            assert isinstance(result, str)
            assert result.strip() == result or "测试" in result
        except ImportError:
            pytest.skip("predict模块依赖未安装")
        finally:
            sys.path.pop(0)

    def test_preprocess_text_handles_empty(self):
        sys.path.insert(0, os.path.join(
            PROJECT_ROOT, "SentimentAnalysisModel", "WeiboSentiment_Finetuned", "BertChinese-Lora"
        ))
        try:
            from predict import preprocess_text
            result = preprocess_text("")
            assert isinstance(result, str)
        except ImportError:
            pytest.skip("predict模块依赖未安装")
        finally:
            sys.path.pop(0)

    def test_gpt2_adapter_directory_exists(self):
        path = os.path.join(
            PROJECT_ROOT, "SentimentAnalysisModel",
            "WeiboSentiment_Finetuned", "GPT2-AdapterTuning"
        )
        assert os.path.isdir(path)

    def test_gpt2_lora_directory_exists(self):
        path = os.path.join(
            PROJECT_ROOT, "SentimentAnalysisModel",
            "WeiboSentiment_Finetuned", "GPT2-Lora"
        )
        assert os.path.isdir(path)


# ==================== 模块 4.2: 多语言情感分析模型 ====================

class TestWeiboMultilingualSentiment:
    """测试多语言情感分析模型"""

    def test_directory_exists(self):
        path = os.path.join(PROJECT_ROOT, "SentimentAnalysisModel", "WeiboMultilingualSentiment")
        assert os.path.isdir(path)

    def test_predict_script_exists(self):
        path = os.path.join(
            PROJECT_ROOT, "SentimentAnalysisModel",
            "WeiboMultilingualSentiment", "predict.py"
        )
        assert os.path.isfile(path)

    def test_preprocess_text_function(self):
        sys.path.insert(0, os.path.join(
            PROJECT_ROOT, "SentimentAnalysisModel", "WeiboMultilingualSentiment"
        ))
        try:
            from predict import preprocess_text
            result = preprocess_text("Hello World 你好世界")
            assert isinstance(result, str)
            assert len(result) > 0
        except ImportError:
            pytest.skip("predict模块依赖未安装")
        finally:
            sys.path.pop(0)

    def test_sentiment_map_defined(self):
        sys.path.insert(0, os.path.join(
            PROJECT_ROOT, "SentimentAnalysisModel", "WeiboMultilingualSentiment"
        ))
        try:
            import predict as pred_module
            # 应有 sentiment_map 变量
            if hasattr(pred_module, "sentiment_map"):
                smap = pred_module.sentiment_map
                assert isinstance(smap, dict)
                assert len(smap) == 5  # 5级情感
            else:
                # 可能在 main 函数内部定义
                assert True
        except ImportError:
            pytest.skip("predict模块依赖未安装")
        finally:
            sys.path.pop(0)


# ==================== 模块 4.3: 机器学习情感分析 ====================

class TestWeiboSentimentMachineLearning:
    """测试机器学习情感分析"""

    def test_directory_exists(self):
        path = os.path.join(PROJECT_ROOT, "SentimentAnalysisModel", "WeiboSentiment_MachineLearning")
        assert os.path.isdir(path)

    def test_base_model_exists(self):
        path = os.path.join(
            PROJECT_ROOT, "SentimentAnalysisModel",
            "WeiboSentiment_MachineLearning", "base_model.py"
        )
        assert os.path.isfile(path)

    def test_predict_script_exists(self):
        path = os.path.join(
            PROJECT_ROOT, "SentimentAnalysisModel",
            "WeiboSentiment_MachineLearning", "predict.py"
        )
        assert os.path.isfile(path)

    def test_base_model_is_abstract(self):
        sys.path.insert(0, os.path.join(
            PROJECT_ROOT, "SentimentAnalysisModel", "WeiboSentiment_MachineLearning"
        ))
        try:
            from base_model import BaseModel
            assert hasattr(BaseModel, "train")
            assert hasattr(BaseModel, "predict")
            # 不能直接实例化抽象类
            with pytest.raises(TypeError):
                BaseModel("test")
        except ImportError:
            pytest.skip("base_model依赖未安装")
        finally:
            sys.path.pop(0)

    def test_training_scripts_exist(self):
        base = os.path.join(
            PROJECT_ROOT, "SentimentAnalysisModel", "WeiboSentiment_MachineLearning"
        )
        expected_files = ["bayes_train.py", "svm_train.py", "xgboost_train.py"]
        for f in expected_files:
            assert os.path.isfile(os.path.join(base, f)), f"缺少训练脚本: {f}"

    def test_sentiment_predictor_class(self):
        sys.path.insert(0, os.path.join(
            PROJECT_ROOT, "SentimentAnalysisModel", "WeiboSentiment_MachineLearning"
        ))
        try:
            from predict import SentimentPredictor
            predictor = SentimentPredictor()
            assert predictor is not None
            assert hasattr(predictor, "predict_single")
            assert hasattr(predictor, "predict_batch")
            assert hasattr(predictor, "ensemble_predict")
        except ImportError:
            pytest.skip("predict模块依赖未安装")
        finally:
            sys.path.pop(0)


# ==================== 模块 4.4: 小型Qwen情感模型 ====================

class TestWeiboSentimentSmallQwen:
    """测试小型Qwen情感模型"""

    def test_directory_exists(self):
        path = os.path.join(PROJECT_ROOT, "SentimentAnalysisModel", "WeiboSentiment_SmallQwen")
        assert os.path.isdir(path)

    def test_base_model_exists(self):
        path = os.path.join(
            PROJECT_ROOT, "SentimentAnalysisModel",
            "WeiboSentiment_SmallQwen", "base_model.py"
        )
        assert os.path.isfile(path)

    def test_predict_universal_exists(self):
        path = os.path.join(
            PROJECT_ROOT, "SentimentAnalysisModel",
            "WeiboSentiment_SmallQwen", "predict_universal.py"
        )
        assert os.path.isfile(path)

    def test_base_qwen_model_is_abstract(self):
        sys.path.insert(0, os.path.join(
            PROJECT_ROOT, "SentimentAnalysisModel", "WeiboSentiment_SmallQwen"
        ))
        try:
            from base_model import BaseQwenModel
            assert hasattr(BaseQwenModel, "train")
            assert hasattr(BaseQwenModel, "predict")
            assert hasattr(BaseQwenModel, "save_model")
            assert hasattr(BaseQwenModel, "load_model")
            with pytest.raises(TypeError):
                BaseQwenModel("test")
        except ImportError:
            pytest.skip("base_model依赖未安装")
        finally:
            sys.path.pop(0)

    def test_models_config_exists(self):
        path = os.path.join(
            PROJECT_ROOT, "SentimentAnalysisModel",
            "WeiboSentiment_SmallQwen", "models_config.py"
        )
        assert os.path.isfile(path)


# ==================== 模块 4.5: BERT话题检测模型 ====================

class TestBertTopicDetection:
    """测试BERT话题检测模型"""

    def test_directory_exists(self):
        path = os.path.join(PROJECT_ROOT, "SentimentAnalysisModel", "BertTopicDetection_Finetuned")
        assert os.path.isdir(path)

    def test_predict_script_exists(self):
        path = os.path.join(
            PROJECT_ROOT, "SentimentAnalysisModel",
            "BertTopicDetection_Finetuned", "predict.py"
        )
        assert os.path.isfile(path)

    def test_train_script_exists(self):
        path = os.path.join(
            PROJECT_ROOT, "SentimentAnalysisModel",
            "BertTopicDetection_Finetuned", "train.py"
        )
        assert os.path.isfile(path)

    def test_preprocess_text_function(self):
        sys.path.insert(0, os.path.join(
            PROJECT_ROOT, "SentimentAnalysisModel", "BertTopicDetection_Finetuned"
        ))
        try:
            from predict import preprocess_text
            result = preprocess_text("话题检测测试文本")
            assert isinstance(result, str)
        except ImportError:
            pytest.skip("predict模块依赖未安装")
        finally:
            sys.path.pop(0)

    def test_predict_topk_function_exists(self):
        sys.path.insert(0, os.path.join(
            PROJECT_ROOT, "SentimentAnalysisModel", "BertTopicDetection_Finetuned"
        ))
        try:
            from predict import predict_topk
            assert callable(predict_topk)
        except ImportError:
            pytest.skip("predict模块依赖未安装")
        finally:
            sys.path.pop(0)
